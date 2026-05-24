/*
  realtime-monitor.js
  Tambahan untuk file PMB STIPI:
  - Kamera wajib aktif sebelum ujian.
  - Admin dapat memantau peserta aktif, on-camera, sedang ujian, selesai, dan log.
  - Data dikirim ke Firebase Realtime Database.
*/

(function(){
  const CFG = window.PMB_CONFIG || {};
  const ROOM = sanitizeKey(CFG.realtimeRoomId || "pmb-stipi-2026");
  const HEARTBEAT_SECONDS = Number(CFG.heartbeatSeconds || 5);
  const ACTIVE_TIMEOUT_SECONDS = Number(CFG.activeTimeoutSeconds || 20);
  const REQUIRE_CAMERA = CFG.requireCameraBeforeExam !== false;

  let firebaseReady = false;
  let db = null;
  let authReady = false;
  let cameraStream = null;
  let cameraReady = false;
  let heartbeatTimer = null;
  let adminParticipantListener = null;
  let adminResultListener = null;
  let participants = {};
  let realtimeResults = {};
  let lastPushAt = 0;

  function sanitizeKey(value){
    return String(value || "").replace(/[.#$/\[\]]/g, "-");
  }

  function hasFirebaseConfig(){
    const c = CFG.firebaseConfig || {};
    return Boolean(c.apiKey && c.authDomain && c.databaseURL && c.projectId && c.appId);
  }

  function pathParticipants(){
    return `pmbRooms/${ROOM}/participants`;
  }

  function pathParticipant(username){
    return `${pathParticipants()}/${sanitizeKey(username || "unknown")}`;
  }

  function pathResults(){
    return `pmbRooms/${ROOM}/results`;
  }

  function esc(value){
    if(typeof window.esc === "function") return window.esc(value);
    return String(value ?? "").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  }

  function getNowISO(){
    return new Date().toISOString();
  }

  function getUser(){
    try{return currentUser || null}catch(e){return null}
  }

  function getCurrentExam(){
    try{return currentExam || null}catch(e){return null}
  }

  function getCurrentExamKey(){
    try{return currentExamKey || ""}catch(e){return ""}
  }

  function getAnswers(){
    try{return Array.isArray(answers) ? answers : []}catch(e){return []}
  }

  function getRemainingSeconds(){
    try{return Number(remainingSeconds || 0)}catch(e){return 0}
  }

  function getLostFocus(){
    try{return Number(lostFocus || 0)}catch(e){return 0}
  }

  function getPackage(){
    try{return typeof getUserPackage === "function" ? getUserPackage() : ""}catch(e){return ""}
  }

  function getCompleted(){
    try{return typeof getCompletedExamsForUser === "function" ? getCompletedExamsForUser() : []}catch(e){return []}
  }

  function getAllowed(){
    try{return typeof allowedExamsForUser === "function" ? allowedExamsForUser() : []}catch(e){return []}
  }

  function isExamActive(){
    const exam = getCurrentExam();
    const key = getCurrentExamKey();
    try{
      return Boolean(exam && key && !examSubmitted);
    }catch(e){
      return Boolean(exam && key);
    }
  }

  function answeredCount(){
    return getAnswers().filter(x => x !== null && x !== undefined).length;
  }

  function currentStatus(){
    const user = getUser();
    if(!user) return {};
    const active = isExamActive();
    const exam = getCurrentExam();
    const completed = getCompleted();
    const allowed = getAllowed();
    let status = "online";

    if(user.role === "admin") status = "admin";
    else if(active) status = "working";
    else if(allowed.length && completed.length >= allowed.length) status = "finished";
    else if(completed.length) status = "partial_done";

    return {
      username: user.username,
      name: user.name || user.username,
      role: user.role,
      online: true,
      status,
      cameraOn: Boolean(cameraReady),
      activeExam: active,
      examKey: active ? getCurrentExamKey() : "",
      examTitle: active && exam ? exam.title : "",
      examPackage: getPackage(),
      answered: active ? answeredCount() : 0,
      total: active && exam ? exam.questions.length : 0,
      remainingSeconds: active ? getRemainingSeconds() : 0,
      lostFocus: active ? getLostFocus() : getLostFocus(),
      completedCount: completed.length,
      completedExams: completed.map(r => ({
        examKey: r.examKey,
        examTitle: r.examTitle,
        score: r.score,
        submittedAt: r.submittedAt
      })),
      lastSeenMs: Date.now(),
      lastSeenISO: getNowISO(),
      network: navigator.onLine ? "online" : "offline",
      tabHidden: document.hidden
    };
  }

  async function initFirebase(){
    if(!hasFirebaseConfig()){
      firebaseReady = false;
      return false;
    }

    try{
      firebase.initializeApp(CFG.firebaseConfig);
      db = firebase.database();

      if(CFG.useAnonymousAuth !== false){
        await firebase.auth().signInAnonymously();
      }

      firebaseReady = true;
      authReady = true;
      return true;
    }catch(err){
      console.warn("Firebase gagal aktif:", err);
      firebaseReady = false;
      return false;
    }
  }

  async function pushStatus(extra){
    const user = getUser();
    if(!firebaseReady || !db || !user) return;
    const now = Date.now();
    if(!extra && now - lastPushAt < 900) return;
    lastPushAt = now;

    const payload = Object.assign(currentStatus(), extra || {});
    try{
      await db.ref(pathParticipant(user.username)).update(payload);
      db.ref(pathParticipant(user.username)).onDisconnect().update({
        online:false,
        status:"offline",
        cameraOn:false,
        activeExam:false,
        lastSeenMs:Date.now(),
        lastSeenISO:getNowISO()
      });
    }catch(err){
      console.warn("Gagal push status:", err);
    }
  }

  function startHeartbeat(){
    stopHeartbeat();
    heartbeatTimer = setInterval(() => pushStatus(), Math.max(3, HEARTBEAT_SECONDS) * 1000);
  }

  function stopHeartbeat(){
    if(heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function ensureCameraDock(){
    let dock = document.getElementById("realtimeCameraDock");
    if(dock) return dock;

    dock = document.createElement("aside");
    dock.id = "realtimeCameraDock";
    dock.className = "camera-dock hidden";
    dock.innerHTML = `
      <div class="camera-dock-head">
        <span class="camera-dot"></span>
        <b>Kamera Peserta Aktif</b>
        <button id="realtimeCameraMin" type="button">−</button>
      </div>
      <video id="realtimeCameraVideo" autoplay playsinline muted></video>
      <p class="camera-note" id="realtimeCameraNote">Wajah peserta harus tetap terlihat selama ujian.</p>
    `;
    document.body.appendChild(dock);
    document.getElementById("realtimeCameraMin").addEventListener("click", () => {
      dock.classList.toggle("minimized");
      document.getElementById("realtimeCameraMin").textContent = dock.classList.contains("minimized") ? "+" : "−";
    });
    return dock;
  }

  function showCameraDock(){
    const dock = ensureCameraDock();
    dock.classList.remove("hidden");
    dock.classList.remove("minimized");
  }

  function hideCameraDock(){
    const dock = document.getElementById("realtimeCameraDock");
    if(dock) dock.classList.add("hidden");
  }

  async function ensureCamera(){
    if(!REQUIRE_CAMERA) return true;
    if(cameraReady && cameraStream){
      showCameraDock();
      pushStatus({cameraOn:true, event:"camera_on"});
      return true;
    }

    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      await showSimpleModal("Kamera Tidak Didukung", "Browser ini belum mendukung akses kamera. Gunakan Chrome atau Edge terbaru.");
      return false;
    }

    try{
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video:{facingMode:"user", width:{ideal:640}, height:{ideal:480}},
        audio:false
      });
      cameraReady = true;
      showCameraDock();
      const video = document.getElementById("realtimeCameraVideo");
      if(video) video.srcObject = cameraStream;
      cameraStream.getVideoTracks().forEach(track => {
        track.addEventListener("ended", () => {
          cameraReady = false;
          pushStatus({cameraOn:false, event:"camera_stopped"});
          const note = document.getElementById("realtimeCameraNote");
          if(note) note.textContent = "Kamera berhenti. Aktifkan kembali jika diminta.";
        });
      });
      pushStatus({cameraOn:true, event:"camera_on"});
      return true;
    }catch(err){
      cameraReady = false;
      pushStatus({cameraOn:false, event:"camera_denied"});
      await showSimpleModal("Kamera Belum Diizinkan", "Ujian membutuhkan kamera aktif. Klik ikon kamera di browser, pilih Allow/Izinkan, lalu coba lagi.");
      return false;
    }
  }

  async function showSimpleModal(title, message){
    if(typeof showActionModal === "function"){
      await showActionModal({
        title,
        message,
        confirmText:"Mengerti",
        hideCancel:true
      });
      return;
    }
    alert(`${title}\n\n${message}`);
  }

  function stopCamera(){
    if(cameraStream){
      cameraStream.getTracks().forEach(t => t.stop());
    }
    cameraStream = null;
    cameraReady = false;
    hideCameraDock();
  }

  function installFunctionHooks(){
    if(typeof startExam === "function" && !startExam.__realtimeHooked){
      const originalStartExam = startExam;
      startExam = async function(key){
        const ok = await ensureCamera();
        if(!ok) return;
        const result = await originalStartExam.apply(this, arguments);
        pushStatus({event:"exam_started"});
        return result;
      };
      startExam.__realtimeHooked = true;
    }

    if(typeof submitExam === "function" && !submitExam.__realtimeHooked){
      const originalSubmitExam = submitExam;
      submitExam = async function(auto){
        const result = await originalSubmitExam.apply(this, arguments);
        try{
          const all = getResults();
          const last = all[all.length - 1];
          if(last && firebaseReady && db){
            await db.ref(`${pathResults()}/${sanitizeKey(last.id)}`).set(Object.assign({}, last, {
              savedAtMs: Date.now(),
              savedAtISO: getNowISO()
            }));
          }
          pushStatus({event:"exam_submitted", activeExam:false, cameraOn:cameraReady});
        }catch(err){
          console.warn("Gagal simpan hasil realtime:", err);
        }
        return result;
      };
      submitExam.__realtimeHooked = true;
    }

    if(typeof renderAdmin === "function" && !renderAdmin.__realtimeHooked){
      const originalRenderAdmin = renderAdmin;
      renderAdmin = function(){
        const result = originalRenderAdmin.apply(this, arguments);
        injectRealtimeAdmin();
        startAdminListeners();
        return result;
      };
      renderAdmin.__realtimeHooked = true;
    }

    if(typeof renderDashboard === "function" && !renderDashboard.__realtimeHooked){
      const originalRenderDashboard = renderDashboard;
      renderDashboard = function(){
        const result = originalRenderDashboard.apply(this, arguments);
        pushStatus({event:"dashboard_rendered"});
        return result;
      };
      renderDashboard.__realtimeHooked = true;
    }
  }

  function injectRealtimeAdmin(){
    const d = document.getElementById("dashboard");
    if(!d) return;

    const old = document.getElementById("realtimeAdminPanel");
    if(old) old.remove();

    const panel = document.createElement("section");
    panel.id = "realtimeAdminPanel";
    panel.className = "realtime-panel";
    panel.innerHTML = realtimeAdminHTML();
    const firstChild = d.children[1] || d.firstChild;
    if(firstChild) d.insertBefore(panel, firstChild);
    else d.appendChild(panel);

    bindRealtimeAdminButtons();
  }

  function realtimeAdminHTML(){
    if(!hasFirebaseConfig()){
      return `
        <div class="realtime-head">
          <div>
            <h2>Realtime Monitor Belum Aktif</h2>
            <p>Upload website tetap bisa, tapi pemantauan aktif/on-camera/sedang ujian perlu Firebase.</p>
          </div>
          <span class="monitor-badge warn">Firebase kosong</span>
        </div>
        <div class="realtime-warning">
          Buka <b>config.js</b>, isi bagian <b>firebaseConfig</b>, aktifkan <b>Anonymous Authentication</b> dan <b>Realtime Database</b>, lalu upload ulang ke GitHub.
        </div>
      `;
    }

    const stats = computeStats();
    return `
      <div class="realtime-head">
        <div>
          <h2>Realtime Monitor Peserta</h2>
          <p>Memantau siapa yang aktif, on-camera, sedang mengerjakan, selesai, dan bermasalah.</p>
        </div>
        <span class="monitor-badge ${firebaseReady ? "ok" : "warn"}">${firebaseReady ? "Firebase aktif" : "Menghubungkan..."}</span>
      </div>

      <div class="realtime-kpis">
        <div class="realtime-kpi ok"><span>Aktif</span><b>${stats.active}</b></div>
        <div class="realtime-kpi ok"><span>On Camera</span><b>${stats.cameraOn}</b></div>
        <div class="realtime-kpi warn"><span>Sedang Ujian</span><b>${stats.working}</b></div>
        <div class="realtime-kpi"><span>Selesai</span><b>${stats.finished}</b></div>
        <div class="realtime-kpi bad"><span>Kamera Off</span><b>${stats.cameraProblem}</b></div>
      </div>

      <div class="realtime-tools">
        <button class="btn btn-primary" id="realtimeExportStatus" type="button">Export Status CSV</button>
        <button class="btn btn-soft" id="realtimeExportResults" type="button">Export Hasil Realtime</button>
        <button class="btn btn-ghost" id="realtimeRefresh" type="button">Refresh Monitor</button>
      </div>

      <div class="realtime-table-wrap">
        <table class="realtime-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Peserta</th>
              <th>Kamera</th>
              <th>Aktivitas</th>
              <th>Ujian</th>
              <th>Progress</th>
              <th>Sisa Waktu</th>
              <th>Tab Keluar</th>
              <th>Update</th>
            </tr>
          </thead>
          <tbody>
            ${renderParticipantRows()}
          </tbody>
        </table>
      </div>
    `;
  }

  function participantArray(){
    return Object.values(participants || {}).filter(p => p && p.role !== "admin").sort((a,b) => String(a.username).localeCompare(String(b.username)));
  }

  function isActive(p){
    return Boolean(p.online) && Date.now() - Number(p.lastSeenMs || 0) <= ACTIVE_TIMEOUT_SECONDS * 1000;
  }

  function computeStats(){
    const arr = participantArray();
    const activeArr = arr.filter(isActive);
    return {
      total: arr.length,
      active: activeArr.length,
      cameraOn: activeArr.filter(p => p.cameraOn).length,
      working: activeArr.filter(p => p.status === "working").length,
      finished: arr.filter(p => p.status === "finished").length,
      cameraProblem: activeArr.filter(p => p.status === "working" && !p.cameraOn).length
    };
  }

  function statusDotClass(p){
    if(!isActive(p)) return "offline";
    if(p.status === "working" && !p.cameraOn) return "bad";
    if(p.status === "working") return "busy";
    return "online";
  }

  function statusText(p){
    if(!isActive(p)) return "Offline";
    if(p.status === "working") return "Sedang ujian";
    if(p.status === "finished") return "Selesai";
    if(p.status === "partial_done") return "Sebagian selesai";
    return "Online";
  }

  function activityText(p){
    if(!isActive(p)) return "Tidak aktif";
    if(p.status === "working") return "Sedang mengerjakan";
    if(p.status === "finished") return "Sudah selesai";
    if(p.status === "partial_done") return `Selesai ${p.completedCount || 0} bagian`;
    return "Menunggu/memilih paket";
  }

  function formatSeconds(sec){
    sec = Number(sec || 0);
    if(sec <= 0) return "-";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function timeAgo(ms){
    if(!ms) return "-";
    const diff = Math.max(0, Date.now() - Number(ms));
    const sec = Math.floor(diff/1000);
    if(sec < 10) return "baru saja";
    if(sec < 60) return `${sec} detik lalu`;
    const min = Math.floor(sec/60);
    if(min < 60) return `${min} menit lalu`;
    return `${Math.floor(min/60)} jam lalu`;
  }

  function renderParticipantRows(){
    const arr = participantArray();
    if(!arr.length){
      return `<tr><td colspan="9">Belum ada peserta yang terhubung ke realtime monitor.</td></tr>`;
    }

    return arr.map(p => `
      <tr>
        <td><span class="status-dot ${statusDotClass(p)}"></span>${esc(statusText(p))}</td>
        <td><b>${esc(p.name || "-")}</b><span class="monitor-small">${esc(p.username || "-")}</span></td>
        <td>${p.cameraOn && isActive(p) ? `<span class="monitor-badge ok">On</span>` : `<span class="monitor-badge bad">Off</span>`}</td>
        <td>${esc(activityText(p))}<span class="monitor-small">${esc(p.examPackage || "")}</span></td>
        <td>${esc(p.examTitle || "-")}<span class="monitor-small">${esc(p.examKey || "")}</span></td>
        <td>${esc(p.answered || 0)}/${esc(p.total || 0)}</td>
        <td>${esc(formatSeconds(p.remainingSeconds))}</td>
        <td>${esc(p.lostFocus || 0)}</td>
        <td>${esc(timeAgo(p.lastSeenMs))}<span class="monitor-small">${esc(p.network || "")}</span></td>
      </tr>
    `).join("");
  }

  function bindRealtimeAdminButtons(){
    const refresh = document.getElementById("realtimeRefresh");
    if(refresh) refresh.onclick = injectRealtimeAdmin;

    const exportStatus = document.getElementById("realtimeExportStatus");
    if(exportStatus) exportStatus.onclick = exportStatusCSV;

    const exportResults = document.getElementById("realtimeExportResults");
    if(exportResults) exportResults.onclick = exportResultsCSV;
  }

  function startAdminListeners(){
    if(!firebaseReady || !db) return;
    if(adminParticipantListener) return;

    adminParticipantListener = db.ref(pathParticipants()).on("value", snap => {
      participants = snap.val() || {};
      injectRealtimeAdmin();
    });

    adminResultListener = db.ref(pathResults()).on("value", snap => {
      realtimeResults = snap.val() || {};
      injectRealtimeAdmin();
    });
  }

  function exportStatusCSV(){
    const rows = [
      ["username","name","status","online","cameraOn","activeExam","examPackage","examKey","examTitle","answered","total","remainingSeconds","lostFocus","completedCount","lastSeenISO","network"]
    ];
    participantArray().forEach(p => rows.push([
      p.username,p.name,p.status,p.online,p.cameraOn,p.activeExam,p.examPackage,p.examKey,p.examTitle,p.answered,p.total,p.remainingSeconds,p.lostFocus,p.completedCount,p.lastSeenISO,p.network
    ]));
    downloadCSV("status-realtime-pmb.csv", rows);
  }

  function exportResultsCSV(){
    const arr = Object.values(realtimeResults || {});
    const rows = [
      ["id","username","name","examPackage","examKey","examTitle","score","correct","wrong","total","startedAt","submittedAt","durationSeconds","autoSubmitted","lostFocus"]
    ];
    arr.forEach(r => rows.push([r.id,r.username,r.name,r.examPackage,r.examKey,r.examTitle,r.score,r.correct,r.wrong,r.total,r.startedAt,r.submittedAt,r.durationSeconds,r.autoSubmitted,r.lostFocus]));
    downloadCSV("hasil-realtime-pmb.csv", rows);
  }

  function csvEscape(v){
    return `"${String(v ?? "").replace(/"/g, '""')}"`;
  }

  function downloadCSV(filename, rows){
    const text = rows.map(row => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([text], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function installEventStatus(){
    document.addEventListener("visibilitychange", () => {
      pushStatus({tabHidden:document.hidden, event:document.hidden ? "tab_hidden" : "tab_visible"});
    });
    window.addEventListener("online", () => pushStatus({network:"online", event:"online"}));
    window.addEventListener("offline", () => pushStatus({network:"offline", event:"offline"}));
    window.addEventListener("beforeunload", () => {
      if(firebaseReady && db){
        const user = getUser();
        if(user){
          db.ref(pathParticipant(user.username)).update({
            online:false,
            cameraOn:false,
            activeExam:false,
            status:"offline",
            lastSeenMs:Date.now(),
            lastSeenISO:getNowISO()
          });
        }
      }
    });
  }

  async function boot(){
    installFunctionHooks();
    installEventStatus();
    await initFirebase();
    installFunctionHooks();
    startHeartbeat();

    // push after login form changes currentUser
    const loginForm = document.getElementById("loginForm");
    if(loginForm){
      loginForm.addEventListener("submit", () => {
        setTimeout(() => {
          pushStatus({event:"login"});
          if(getUser() && getUser().role === "admin"){
            injectRealtimeAdmin();
            startAdminListeners();
          }
        }, 250);
      });
    }

    setInterval(() => {
      if(getUser()){
        pushStatus();
      }
    }, Math.max(3, HEARTBEAT_SECONDS) * 1000);
  }

  boot();

  window.PMB_REALTIME_MONITOR = {
    pushStatus,
    ensureCamera,
    exportStatusCSV,
    exportResultsCSV
  };
})();
