/*
  realtime-monitor.js - Snapshot + Mobile Stable Edition
  Tambahan untuk PMB STIPI:
  - Kamera aktif hanya saat ujian dimulai.
  - Admin melihat status realtime + snapshot berkala, bukan live video.
  - Refresh tetap kembali ke halaman terakhir karena app.js sudah menyimpan sesi aktif.
  - Kamera diperkecil otomatis di HP agar tidak menutupi jawaban.
*/
(function(){
  const CFG = window.PMB_CONFIG || {};
  const ROOM = sanitizeKey(CFG.realtimeRoomId || "pmb-stipi-2026");
  const HEARTBEAT_SECONDS = Number(CFG.heartbeatSeconds || 5);
  const ACTIVE_TIMEOUT_SECONDS = Number(CFG.activeTimeoutSeconds || 20);
  const REQUIRE_CAMERA = CFG.requireCameraBeforeExam !== false;
  const SHOW_CAMERA_MONITOR = CFG.showCameraMonitor !== false;
  const ENABLE_SNAPSHOTS = CFG.enableSnapshots !== false;
  const SNAPSHOT_INTERVAL_SECONDS = Math.max(45, Number(CFG.snapshotIntervalSeconds || 90));
  const SNAPSHOT_WIDTH = Number(CFG.snapshotWidth || 144);
  const SNAPSHOT_HEIGHT = Number(CFG.snapshotHeight || 108);
  const SNAPSHOT_QUALITY = Number(CFG.snapshotQuality || 0.28);

  let firebaseReady = false;
  let db = null;
  let cameraStream = null;
  let cameraReady = false;
  let heartbeatTimer = null;
  let snapshotTimer = null;
  let adminParticipantListener = null;
  let adminResultListener = null;
  let participants = {};
  let realtimeResults = {};
  let lastPushAt = 0;
  let snapshotCount = 0;
  let lastSnapshot = "";
  let lastSnapshotAt = "";
  let cameraInitializedForExam = false;

  function sanitizeKey(value){return String(value || "").replace(/[.#$/\[\]]/g, "-");}
  function hasFirebaseConfig(){const c = CFG.firebaseConfig || {}; return Boolean(c.apiKey && c.authDomain && c.databaseURL && c.projectId && c.appId);}
  function pathParticipants(){return `pmbRooms/${ROOM}/participants`;}
  function pathParticipant(username){return `${pathParticipants()}/${sanitizeKey(username || "unknown")}`;}
  function pathResults(){return `pmbRooms/${ROOM}/results`;}
  function esc(value){return String(value ?? "").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));}
  function nowISO(){return new Date().toISOString();}
  function getUser(){try{return currentUser || null}catch(e){return null}}
  function getCurrentExam(){try{return currentExam || null}catch(e){return null}}
  function getCurrentExamKey(){try{return currentExamKey || ""}catch(e){return ""}}
  function getAnswers(){try{return Array.isArray(answers) ? answers : []}catch(e){return []}}
  function getRemainingSeconds(){try{return Number(remainingSeconds || 0)}catch(e){return 0}}
  function getLostFocus(){try{return Number(lostFocus || 0)}catch(e){return 0}}
  function getPackage(){try{return typeof getUserPackage === "function" ? getUserPackage() : ""}catch(e){return ""}}
  function getCompleted(){try{return typeof getCompletedExamsForUser === "function" ? getCompletedExamsForUser() : []}catch(e){return []}}
  function getAllowed(){try{return typeof allowedExamsForUser === "function" ? allowedExamsForUser() : []}catch(e){return []}}
  function isExamActive(){const exam=getCurrentExam(); const key=getCurrentExamKey(); try{return Boolean(exam && key && !examSubmitted)}catch(e){return Boolean(exam && key)}}
  function answeredCount(){return getAnswers().filter(x => x !== null && x !== undefined).length;}

  function currentStatus(extra){
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

    return Object.assign({
      username: user.username,
      name: user.name || user.username,
      role: user.role,
      online: true,
      status,
      cameraOn: SHOW_CAMERA_MONITOR ? Boolean(cameraReady) : null,
      activeExam: active,
      examKey: active ? getCurrentExamKey() : "",
      examTitle: active && exam ? exam.title : "",
      examPackage: getPackage(),
      answered: active ? answeredCount() : 0,
      total: active && exam ? exam.questions.length : 0,
      remainingSeconds: active ? getRemainingSeconds() : 0,
      lostFocus: getLostFocus(),
      completedCount: completed.length,
      completedExams: completed.map(r => ({examKey:r.examKey, examTitle:r.examTitle, score:r.score, submittedAt:r.submittedAt})),
      latestSnapshot: SHOW_CAMERA_MONITOR && ENABLE_SNAPSHOTS ? lastSnapshot : "",
      latestSnapshotAt: SHOW_CAMERA_MONITOR && ENABLE_SNAPSHOTS ? lastSnapshotAt : "",
      snapshotCount: SHOW_CAMERA_MONITOR && ENABLE_SNAPSHOTS ? snapshotCount : 0,
      lastSeenMs: Date.now(),
      lastSeenISO: nowISO(),
      network: navigator.onLine ? "online" : "offline",
      tabHidden: document.hidden
    }, extra || {});
  }

  async function initFirebase(){
    if(!hasFirebaseConfig()){ firebaseReady=false; return false; }
    try{
      if(!firebase.apps.length) firebase.initializeApp(CFG.firebaseConfig);
      db = firebase.database();
      if(CFG.useAnonymousAuth !== false){ await firebase.auth().signInAnonymously(); }
      firebaseReady = true;
      return true;
    }catch(err){ console.warn("Firebase gagal aktif:", err); firebaseReady=false; return false; }
  }

  async function pushStatus(extra){
    const user=getUser();
    if(!firebaseReady || !db || !user) return;
    const now=Date.now();
    if(!extra && now-lastPushAt<1200) return;
    lastPushAt=now;
    try{
      await db.ref(pathParticipant(user.username)).update(currentStatus(extra));
      db.ref(pathParticipant(user.username)).onDisconnect().update({
        online:false,status:"offline",cameraOn:false,activeExam:false,lastSeenMs:Date.now(),lastSeenISO:nowISO()
      });
    }catch(err){ console.warn("Gagal push status:", err); }
  }

  function startHeartbeat(){stopHeartbeat(); heartbeatTimer=setInterval(()=>pushStatus(), Math.max(3,HEARTBEAT_SECONDS)*1000);}
  function stopHeartbeat(){if(heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer=null;}


  const CAMERA_DOCK_STORAGE_KEY = "pmb.cameraDockPosition";
  let cameraDragState = null;

  function readDockPosition(){
    try{
      const raw = localStorage.getItem(CAMERA_DOCK_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }

  function saveDockPosition(pos){
    try{ localStorage.setItem(CAMERA_DOCK_STORAGE_KEY, JSON.stringify(pos)); }catch(e){}
  }

  function clampDockPosition(x, y, dock){
    const padding = 8;
    const width = dock.offsetWidth || 220;
    const height = dock.offsetHeight || 150;
    const maxX = Math.max(padding, window.innerWidth - width - padding);
    const maxY = Math.max(padding, window.innerHeight - height - padding);
    return {
      x: Math.min(Math.max(padding, x), maxX),
      y: Math.min(Math.max(padding, y), maxY)
    };
  }

  function applyDockPosition(pos){
    const dock = document.getElementById("realtimeCameraDock");
    if(!dock || !pos || typeof pos.x !== "number" || typeof pos.y !== "number") return;
    const clamped = clampDockPosition(pos.x, pos.y, dock);
    dock.style.left = clamped.x + "px";
    dock.style.top = clamped.y + "px";
    dock.style.right = "auto";
    dock.style.bottom = "auto";
  }

  function resetDockPosition(){
    const dock = document.getElementById("realtimeCameraDock");
    if(!dock) return;
    dock.style.left = "";
    dock.style.top = "";
    dock.style.right = "";
    dock.style.bottom = "";
    try{ localStorage.removeItem(CAMERA_DOCK_STORAGE_KEY); }catch(e){}
  }

  function makeDockDraggable(){
    const dock = document.getElementById("realtimeCameraDock");
    const head = document.getElementById("realtimeCameraHead");
    if(!dock || !head || head.dataset.dragReady === "1") return;
    head.dataset.dragReady = "1";

    const startDrag = (clientX, clientY) => {
      const rect = dock.getBoundingClientRect();
      cameraDragState = {
        offsetX: clientX - rect.left,
        offsetY: clientY - rect.top
      };
      dock.classList.add("dragging");
    };

    const moveDrag = (clientX, clientY) => {
      if(!cameraDragState) return;
      const x = clientX - cameraDragState.offsetX;
      const y = clientY - cameraDragState.offsetY;
      const clamped = clampDockPosition(x, y, dock);
      dock.style.left = clamped.x + "px";
      dock.style.top = clamped.y + "px";
      dock.style.right = "auto";
      dock.style.bottom = "auto";
    };

    const stopDrag = () => {
      if(!cameraDragState) return;
      cameraDragState = null;
      dock.classList.remove("dragging");
      const rect = dock.getBoundingClientRect();
      saveDockPosition({x: rect.left, y: rect.top});
    };

    head.addEventListener("pointerdown", (e) => {
      if(e.target.closest("button")) return;
      startDrag(e.clientX, e.clientY);
      try{ head.setPointerCapture(e.pointerId); }catch(err){}
      e.preventDefault();
    });

    head.addEventListener("pointermove", (e) => {
      if(!cameraDragState) return;
      moveDrag(e.clientX, e.clientY);
      e.preventDefault();
    });

    head.addEventListener("pointerup", stopDrag);
    head.addEventListener("pointercancel", stopDrag);

    head.addEventListener("dblclick", () => {
      resetDockPosition();
    });

    window.addEventListener("resize", () => {
      const saved = readDockPosition();
      if(saved){
        setTimeout(() => applyDockPosition(saved), 60);
      }
    });
  }

  function ensureCameraDock(){
    let dock=document.getElementById("realtimeCameraDock");
    if(dock) return dock;
    dock=document.createElement("aside");
    dock.id="realtimeCameraDock";
    dock.className="camera-dock hidden";
    dock.innerHTML=`
      <div class="camera-dock-head" id="realtimeCameraHead">
        <span class="camera-dot"></span>
        <b>Kamera Aktif</b>
        <span class="camera-drag-hint">Geser</span>
        <button id="realtimeCameraMin" type="button">−</button>
      </div>
      <video id="realtimeCameraVideo" autoplay playsinline muted></video>
      <p class="camera-note" id="realtimeCameraNote">Snapshot dikirim berkala ke admin. Bukan live video. Kotak kamera bisa digeser.</p>
    `;
    document.body.appendChild(dock);
    document.getElementById("realtimeCameraMin").addEventListener("click",()=>toggleCameraMinimized());
    makeDockDraggable();
    const savedPos = readDockPosition();
    if(savedPos) setTimeout(()=>applyDockPosition(savedPos), 50);
    return dock;
  }

  function toggleCameraMinimized(force){
    const dock=document.getElementById("realtimeCameraDock");
    if(!dock) return;
    const btn=document.getElementById("realtimeCameraMin");
    if(typeof force === "boolean") dock.classList.toggle("minimized", force);
    else dock.classList.toggle("minimized");
    if(btn) btn.textContent = dock.classList.contains("minimized") ? "+" : "−";
  }

  function showCameraDock(){
    if(!SHOW_CAMERA_MONITOR) return;
    const dock=ensureCameraDock();
    dock.classList.remove("hidden");
    const isPhone = window.matchMedia("(max-width: 760px)").matches;
    toggleCameraMinimized(isPhone);
    const savedPos = readDockPosition();
    if(savedPos) setTimeout(()=>applyDockPosition(savedPos), 30);
  }
  function hideCameraDock(){const dock=document.getElementById("realtimeCameraDock"); if(dock) dock.classList.add("hidden");}

  async function ensureCamera(){
    if(!SHOW_CAMERA_MONITOR) return true;
    if(!REQUIRE_CAMERA && !cameraStream) return true;
    if(cameraReady && cameraStream){ showCameraDock(); startSnapshots(); await pushStatus({cameraOn:true,event:"camera_on"}); return true; }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ await showSimpleModal("Kamera Tidak Didukung", "Gunakan Chrome atau Edge terbaru."); return false; }
    try{
      cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"user", width:{ideal:480}, height:{ideal:360}}, audio:false});
      cameraReady = true;
      showCameraDock();
      const video=document.getElementById("realtimeCameraVideo");
      if(video) video.srcObject = cameraStream;
      cameraStream.getVideoTracks().forEach(track=>track.addEventListener("ended",()=>{
        cameraReady=false; stopSnapshots(); pushStatus({cameraOn:false,event:"camera_stopped"});
        const note=document.getElementById("realtimeCameraNote"); if(note) note.textContent="Kamera berhenti. Aktifkan kembali jika diminta.";
      }));
      startSnapshots();
      setTimeout(()=>captureAndSendSnapshot("camera_started"), 1200);
      await pushStatus({cameraOn:true,event:"camera_on"});
      return true;
    }catch(err){
      cameraReady=false; await pushStatus({cameraOn:false,event:"camera_denied"});
      await showSimpleModal("Kamera Belum Diizinkan", "Ujian membutuhkan kamera aktif. Klik ikon kamera di browser, pilih Allow/Izinkan, lalu coba lagi.");
      return false;
    }
  }

  async function showSimpleModal(title,message){
    if(typeof showActionModal === "function"){
      await showActionModal({title,message,confirmText:"Mengerti",hideCancel:true}); return;
    }
    alert(`${title}\n\n${message}`);
  }

  function startSnapshots(){
    if(!SHOW_CAMERA_MONITOR || !ENABLE_SNAPSHOTS || !cameraReady) return;
    stopSnapshots();
    snapshotTimer = setInterval(()=>captureAndSendSnapshot("interval"), SNAPSHOT_INTERVAL_SECONDS*1000);
  }
  function stopSnapshots(){if(snapshotTimer) clearInterval(snapshotTimer); snapshotTimer=null;}

  async function captureAndSendSnapshot(label){
    if(!SHOW_CAMERA_MONITOR || !ENABLE_SNAPSHOTS || !cameraReady || !isExamActive()) return;
    const video=document.getElementById("realtimeCameraVideo");
    if(!video || video.readyState < 2) return;
    try{
      const canvas=document.createElement("canvas");
      canvas.width=SNAPSHOT_WIDTH; canvas.height=SNAPSHOT_HEIGHT;
      const ctx=canvas.getContext("2d", {alpha:false});
      ctx.translate(canvas.width,0); ctx.scale(-1,1);
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      lastSnapshot=canvas.toDataURL("image/jpeg", SNAPSHOT_QUALITY);
      lastSnapshotAt=nowISO();
      snapshotCount++;
      await pushStatus({event:"snapshot", latestSnapshot:lastSnapshot, latestSnapshotAt:lastSnapshotAt, snapshotCount});
    }catch(err){ console.warn("Snapshot gagal:", err); }
  }

  function stopCamera(){
    stopSnapshots();
    if(cameraStream) cameraStream.getTracks().forEach(t=>t.stop());
    cameraStream=null; cameraReady=false; cameraInitializedForExam=false; hideCameraDock();
  }


  function readLocalResultsSafe(){
    try{
      if(typeof getResults === "function"){
        const r = getResults();
        if(Array.isArray(r)) return r;
      }
    }catch(e){}
    try{
      const candidates = [
        "pmb_results_v5",
        "pmbResults",
        "results",
        "pmb-stipi-results",
        "PMB_RESULTS",
        "examResults"
      ];
      for(const key of candidates){
        const raw = localStorage.getItem(key);
        if(!raw) continue;
        const parsed = JSON.parse(raw);
        if(Array.isArray(parsed)) return parsed;
      }
    }catch(e){}
    return [];
  }

  function latestLocalResult(beforeLength){
    const arr = readLocalResultsSafe();
    if(!arr.length) return null;
    if(typeof beforeLength === "number" && arr.length > beforeLength){
      return arr[arr.length - 1];
    }
    return arr[arr.length - 1];
  }

  function normalizeRealtimeResult(rawResult, auto){
    const user = getUser() || {};
    const exam = getCurrentExam();
    const examKey = (rawResult && (rawResult.examKey || rawResult.subject || rawResult.exam || rawResult.key)) || getCurrentExamKey() || "";
    const examTitle = (rawResult && (rawResult.examTitle || rawResult.subjectTitle || rawResult.title)) || (exam && exam.title) || examKey || "-";
    const id = (rawResult && rawResult.id) || `result-${user.username || "peserta"}-${examKey || "exam"}-${Date.now()}`;

    const total = Number((rawResult && (rawResult.total || rawResult.totalQuestions || rawResult.questionCount)) || (exam && exam.questions ? exam.questions.length : 0) || 0);
    const correct = Number((rawResult && (rawResult.correct || rawResult.correctCount || rawResult.right)) || 0);
    const wrong = Number((rawResult && (rawResult.wrong || rawResult.wrongCount)) || Math.max(0, total - correct));
    const score = Number((rawResult && (rawResult.score || rawResult.percentage || rawResult.nilai)) || (total ? Math.round((correct/total)*100) : 0));

    return Object.assign({}, rawResult || {}, {
      id,
      username: (rawResult && rawResult.username) || user.username || "",
      name: (rawResult && rawResult.name) || user.name || user.username || "",
      examPackage: (rawResult && rawResult.examPackage) || getPackage() || "",
      examKey,
      examTitle,
      score,
      correct,
      wrong,
      total,
      startedAt: (rawResult && rawResult.startedAt) || "",
      submittedAt: (rawResult && rawResult.submittedAt) || nowISO(),
      durationSeconds: (rawResult && rawResult.durationSeconds) || 0,
      autoSubmitted: Boolean((rawResult && rawResult.autoSubmitted) || auto),
      lostFocus: (rawResult && rawResult.lostFocus) || getLostFocus(),
      snapshotCount,
      latestSnapshotAt,
      savedAtMs: Date.now(),
      savedAtISO: nowISO()
    });
  }

  async function saveRealtimeResult(rawResult, auto){
    if(!firebaseReady || !db) return false;
    const result = normalizeRealtimeResult(rawResult, auto);
    try{
      await db.ref(`${pathResults()}/${sanitizeKey(result.id)}`).set(result);
      realtimeResults = Object.assign({}, realtimeResults || {}, {[sanitizeKey(result.id)]: result});
      await pushStatus({
        event:"result_saved",
        activeExam:false,
        lastResultId:result.id,
        lastScore:result.score,
        lastExamTitle:result.examTitle
      });
      return true;
    }catch(err){
      console.warn("Gagal simpan hasil realtime:", err);
      return false;
    }
  }

  function installFunctionHooks(){
    if(typeof startExam === "function" && !startExam.__snapshotHooked){
      const originalStartExam = startExam;
      startExam = async function(key){
        const ok = await ensureCamera();
        if(!ok) return;
        cameraInitializedForExam = true;
        const result = await originalStartExam.apply(this, arguments);
        startSnapshots();
        await pushStatus({event:"exam_started", cameraOn:cameraReady});
        return result;
      };
      startExam.__snapshotHooked = true;
    }

    if(typeof submitExam === "function" && !submitExam.__snapshotHooked){
      const originalSubmitExam = submitExam;
      submitExam = async function(auto){
        const beforeLen = readLocalResultsSafe().length;
        const result = await originalSubmitExam.apply(this, arguments);

        // app.js usually saves result to localStorage inside originalSubmitExam.
        // We read it back after submit, then push the same result to Firebase.
        setTimeout(async () => {
          try{
            const last = latestLocalResult(beforeLen);
            await saveRealtimeResult(last, auto);
            injectRealtimeAdmin();
          }catch(err){
            console.warn("Gagal proses hasil realtime setelah submit:", err);
          }
        }, 250);

        return result;
      };
      submitExam.__snapshotHooked = true;
    }


    if(typeof renderAdmin === "function" && !renderAdmin.__snapshotHooked){
      const originalRenderAdmin = renderAdmin;
      renderAdmin = function(){const result=originalRenderAdmin.apply(this,arguments); injectRealtimeAdmin(); startAdminListeners(); return result;};
      renderAdmin.__snapshotHooked = true;
    }

    if(typeof renderDashboard === "function" && !renderDashboard.__snapshotHooked){
      const originalRenderDashboard = renderDashboard;
      renderDashboard = function(){const result=originalRenderDashboard.apply(this,arguments); pushStatus({event:"dashboard"}); return result;};
      renderDashboard.__snapshotHooked = true;
    }
  }

  function injectRealtimeAdmin(){
    const d = document.getElementById("dashboard");
    const user = getUser();
    if(!d || !user || user.role !== "admin") return;

    let panel = document.getElementById("realtimeAdminPanel");
    if(!panel){
      panel = document.createElement("section");
      panel.id = "realtimeAdminPanel";
      panel.className = "realtime-panel";
      // Put realtime panel near top, after the first hero/card if possible.
      const firstCard = d.firstElementChild;
      if(firstCard && firstCard.nextSibling){
        d.insertBefore(panel, firstCard.nextSibling);
      }else if(firstCard){
        firstCard.insertAdjacentElement("afterend", panel);
      }else{
        d.appendChild(panel);
      }
    }

    panel.innerHTML = realtimeAdminHTML();
    bindRealtimeAdminButtons();
  }

  function realtimeAdminHTML(){
    if(!hasFirebaseConfig()){
      return `<div class="realtime-head"><div><h2>Realtime Monitor Belum Aktif</h2><p>Isi Firebase di config.js agar admin bisa memantau peserta.</p></div><span class="monitor-badge warn">Firebase kosong</span></div><div class="realtime-warning">Buka <b>config.js</b>, isi <b>firebaseConfig</b>, aktifkan <b>Anonymous Authentication</b> dan <b>Realtime Database</b>, lalu upload ulang.</div>`;
    }
    const stats=computeStats();
    return `
      <div class="realtime-head">
        <div><h2>Realtime Monitor + Snapshot</h2><p>Admin memantau peserta aktif, on-camera, sedang ujian, selesai, progress, sisa waktu, dan snapshot berkala.</p></div>
        <span class="monitor-badge ${firebaseReady?'ok':'warn'}">${firebaseReady?'Firebase aktif':'Menghubungkan...'}</span>
      </div>
      <div class="realtime-kpis">
        <div class="realtime-kpi ok"><span>Aktif</span><b>${stats.active}</b></div>
        <div class="realtime-kpi ok"><span>On Camera</span><b>${stats.cameraOn}</b></div>
        <div class="realtime-kpi warn"><span>Sedang Ujian</span><b>${stats.working}</b></div>
        <div class="realtime-kpi"><span>Selesai</span><b>${stats.finished}</b></div>
        <div class="realtime-kpi bad"><span>Keluar Tab</span><b>${stats.lostFocus}</b></div>
      </div>
      <div class="realtime-tools">
        <button class="btn btn-primary" id="realtimeExportStatus" type="button">Export Status CSV</button>
        <button class="btn btn-soft" id="realtimeExportResults" type="button">Export Hasil Realtime</button>
        <button class="btn btn-ghost" id="realtimeRefresh" type="button">Refresh Monitor</button>
      </div>
      <div class="realtime-table-wrap">
        <table class="realtime-table">
          <thead><tr><th>Status</th><th>Snapshot</th><th>Peserta</th><th>Kamera</th><th>Aktivitas</th><th>Ujian</th><th>Progress</th><th>Sisa Waktu</th><th>Keluar Tab</th><th>Update</th></tr></thead>
          <tbody>${renderParticipantRows()}</tbody>
        </table>
      </div>`;
  }


  function realtimeResultArray(){
    const firebaseResults = Object.values(realtimeResults || {});
    const localResults = readLocalResultsSafe().map(r => normalizeRealtimeResult(r, false));
    const map = {};
    firebaseResults.concat(localResults).forEach(r => {
      if(!r) return;
      const id = r.id || `${r.username || ""}-${r.examKey || r.examTitle || ""}-${r.submittedAt || ""}`;
      map[id] = r;
    });
    return Object.values(map).sort((a,b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
  }

  function renderRealtimeResultRows(){
    const arr = realtimeResultArray();
    if(!arr.length){
      return `<tr><td colspan="9">Belum ada hasil submit realtime. Jika peserta sudah submit, klik Refresh Monitor.</td></tr>`;
    }
    return arr.map(r => `
      <tr>
        <td><b>${esc(r.name || "-")}</b><span class="monitor-small">${esc(r.username || "-")}</span></td>
        <td>${esc(r.examPackage || "-")}</td>
        <td>${esc(r.examTitle || r.examKey || "-")}<span class="monitor-small">${esc(r.examKey || "")}</span></td>
        <td><b>${esc(r.score ?? "-")}</b></td>
        <td>${esc(r.correct ?? "-")}/${esc(r.total ?? "-")}</td>
        <td>${esc(r.wrong ?? "-")}</td>
        <td>${esc(r.lostFocus || 0)}</td>
        <td>${esc(r.snapshotCount || 0)}<span class="monitor-small">${esc(r.latestSnapshotAt || "")}</span></td>
        <td>${esc(r.submittedAt || "-")}</td>
      </tr>
    `).join("");
  }

  function participantArray(){return Object.values(participants || {}).filter(p=>p && p.role!=="admin").sort((a,b)=>String(a.username).localeCompare(String(b.username)));}
  function isActive(p){return Boolean(p.online) && Date.now()-Number(p.lastSeenMs || 0) <= ACTIVE_TIMEOUT_SECONDS*1000;}
  function computeStats(){const arr=participantArray(); const active=arr.filter(isActive); return {total:arr.length, active:active.length, cameraOn:active.filter(p=>p.cameraOn).length, working:active.filter(p=>p.status==="working").length, finished:arr.filter(p=>p.status==="finished").length, lostFocus:arr.reduce((s,p)=>s+Number(p.lostFocus||0),0)};}
  function dotClass(p){if(!isActive(p)) return "offline"; if(p.status==="working" && !p.cameraOn) return "bad"; if(p.status==="working") return "busy"; return "online";}
  function statusText(p){if(!isActive(p)) return "Offline"; if(p.status==="working") return "Sedang ujian"; if(p.status==="finished") return "Selesai"; if(p.status==="partial_done") return "Sebagian selesai"; return "Online";}
  function activityText(p){if(!isActive(p)) return "Tidak aktif"; if(p.status==="working") return "Sedang mengerjakan"; if(p.status==="finished") return "Selesai semua"; if(p.status==="partial_done") return `Selesai ${p.completedCount||0} bagian`; return "Menunggu/memilih paket";}
  function formatSeconds(sec){sec=Number(sec||0); if(sec<=0) return "-"; const m=Math.floor(sec/60), s=sec%60; return `${m}m ${String(s).padStart(2,"0")}s`;}
  function timeAgo(ms){if(!ms) return "-"; const diff=Math.max(0,Date.now()-Number(ms)); const sec=Math.floor(diff/1000); if(sec<10)return"baru saja"; if(sec<60)return`${sec} detik lalu`; const min=Math.floor(sec/60); if(min<60)return`${min} menit lalu`; return`${Math.floor(min/60)} jam lalu`;}
  function snapshotCell(p){
    if(p.latestSnapshot && isActive(p)) return `<img class="snapshot-thumb" src="${p.latestSnapshot}" alt="Snapshot ${esc(p.username)}"><span class="monitor-small">${esc(p.latestSnapshotAt ? timeAgo(new Date(p.latestSnapshotAt).getTime()) : '')}</span>`;
    return `<span class="monitor-badge warn">Belum ada</span>`;
  }
  function renderParticipantRows(){
    const arr=participantArray(); if(!arr.length) return `<tr><td colspan="10">Belum ada peserta yang terhubung ke realtime monitor.</td></tr>`;
    return arr.map(p=>`<tr>
      <td><span class="status-dot ${dotClass(p)}"></span>${esc(statusText(p))}</td>
      <td>${snapshotCell(p)}</td>
      <td><b>${esc(p.name||'-')}</b><span class="monitor-small">${esc(p.username||'-')}</span></td>
      <td>${p.cameraOn && isActive(p) ? `<span class="monitor-badge ok">On</span>` : `<span class="monitor-badge bad">Off</span>`}<span class="monitor-small">Snapshot: ${esc(p.snapshotCount||0)}</span></td>
      <td>${esc(activityText(p))}<span class="monitor-small">${esc(p.examPackage||'')}</span></td>
      <td>${esc(p.examTitle||'-')}<span class="monitor-small">${esc(p.examKey||'')}</span></td>
      <td>${esc(p.answered||0)}/${esc(p.total||0)}</td>
      <td>${esc(formatSeconds(p.remainingSeconds))}</td>
      <td>${esc(p.lostFocus||0)}</td>
      <td>${esc(timeAgo(p.lastSeenMs))}<span class="monitor-small">${esc(p.network||'')}</span></td>
    </tr>`).join("");
  }

  function bindRealtimeAdminButtons(){
    const refresh = document.getElementById("realtimeRefresh");
    if(refresh){
      refresh.onclick = async () => {
        refresh.disabled = true;
        const oldText = refresh.textContent;
        refresh.textContent = "Memuat...";
        try{
          if(firebaseReady && db){
            const pSnap = await db.ref(pathParticipants()).once("value");
            participants = pSnap.val() || {};
            const rSnap = await db.ref(pathResults()).once("value");
            realtimeResults = rSnap.val() || {};
          }
          injectRealtimeAdmin();
        }catch(err){
          console.warn("Refresh monitor gagal:", err);
          injectRealtimeAdmin();
        }finally{
          const btn = document.getElementById("realtimeRefresh");
          if(btn){
            btn.disabled = false;
            btn.textContent = oldText || "Refresh Monitor";
          }
        }
      };
    }

    const exportStatus = document.getElementById("realtimeExportStatus");
    if(exportStatus) exportStatus.onclick = exportStatusCSV;

    const exportResults = document.getElementById("realtimeExportResults");
    if(exportResults) exportResults.onclick = exportResultsCSV;
  }

  function startAdminListeners(){
    if(!firebaseReady || !db) {
      injectRealtimeAdmin();
      return;
    }

    try{
      if(adminParticipantListener){
        db.ref(pathParticipants()).off("value", adminParticipantListener);
      }
      if(adminResultListener){
        db.ref(pathResults()).off("value", adminResultListener);
      }
    }catch(e){}

    adminParticipantListener = snap => {
      participants = snap.val() || {};
      injectRealtimeAdmin();
    };
    adminResultListener = snap => {
      realtimeResults = snap.val() || {};
      injectRealtimeAdmin();
    };

    db.ref(pathParticipants()).on("value", adminParticipantListener);
    db.ref(pathResults()).on("value", adminResultListener);
  }

  function exportStatusCSV(){
    const rows=[["username","name","status","online","cameraOn","activeExam","examPackage","examKey","examTitle","answered","total","remainingSeconds","lostFocus","snapshotCount","latestSnapshotAt","lastSeenISO","network"]];
    participantArray().forEach(p=>rows.push([p.username,p.name,p.status,p.online,p.cameraOn,p.activeExam,p.examPackage,p.examKey,p.examTitle,p.answered,p.total,p.remainingSeconds,p.lostFocus,p.snapshotCount,p.latestSnapshotAt,p.lastSeenISO,p.network]));
    downloadCSV("status-realtime-pmb-snapshot.csv", rows);
  }
  function exportResultsCSV(){
    const arr = realtimeResultArray();
    const rows=[["id","username","name","examPackage","examKey","examTitle","score","correct","wrong","total","startedAt","submittedAt","durationSeconds","autoSubmitted","lostFocus","snapshotCount"]];
    arr.forEach(r=>rows.push([r.id,r.username,r.name,r.examPackage,r.examKey,r.examTitle,r.score,r.correct,r.wrong,r.total,r.startedAt,r.submittedAt,r.durationSeconds,r.autoSubmitted,r.lostFocus,r.snapshotCount]));
    downloadCSV("hasil-realtime-pmb-snapshot.csv", rows);
  }
  function csvEscape(v){return `"${String(v ?? "").replace(/"/g,'""')}"`;}
  function downloadCSV(filename, rows){const text=rows.map(row=>row.map(csvEscape).join(",")).join("\n"); const blob=new Blob([text],{type:"text/csv;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);}

  function installEventStatus(){
    document.addEventListener("visibilitychange",()=>pushStatus({tabHidden:document.hidden,event:document.hidden?"tab_hidden":"tab_visible"}));
    window.addEventListener("online",()=>pushStatus({network:"online",event:"online"}));
    window.addEventListener("offline",()=>pushStatus({network:"offline",event:"offline"}));
    window.addEventListener("beforeunload",()=>{const user=getUser(); if(firebaseReady&&db&&user){db.ref(pathParticipant(user.username)).update({online:false,cameraOn:false,activeExam:false,status:"offline",lastSeenMs:Date.now(),lastSeenISO:nowISO()});}});
  }

  function isAdminDashboardVisible(){
    const user = getUser();
    const dashboard = document.getElementById("dashboard");
    if(!user || user.role !== "admin" || !dashboard) return false;
    return !dashboard.classList.contains("hidden") && dashboard.offsetParent !== null;
  }

  function ensureRealtimePanelAfterRefresh(){
    const user = getUser();
    if(!user || user.role !== "admin") return;

    const dashboard = document.getElementById("dashboard");
    if(!dashboard) return;

    // If app.js restored admin dashboard after refresh, realtime panel must be mounted again.
    if(!document.getElementById("realtimeAdminPanel")){
      injectRealtimeAdmin();
    }else{
      // Keep numbers fresh without waiting for a button.
      const panel = document.getElementById("realtimeAdminPanel");
      if(panel && !panel.dataset.boundRefresh){
        bindRealtimeAdminButtons();
        panel.dataset.boundRefresh = "1";
      }
    }

    if(firebaseReady && db){
      startAdminListeners();
    }
  }

  async function boot(){
    installFunctionHooks(); installEventStatus(); await initFirebase(); installFunctionHooks(); startHeartbeat();

    // adminRefreshWatchdogV2: keeps realtime panel alive after admin refresh / dashboard re-render
    setTimeout(ensureRealtimePanelAfterRefresh, 200);
    setTimeout(ensureRealtimePanelAfterRefresh, 800);
    setTimeout(ensureRealtimePanelAfterRefresh, 1600);
    setInterval(ensureRealtimePanelAfterRefresh, 2500);
    const loginForm=document.getElementById("loginForm");
    if(loginForm) loginForm.addEventListener("submit",()=>setTimeout(()=>{pushStatus({event:"login"}); if(getUser()&&getUser().role==="admin"){injectRealtimeAdmin(); startAdminListeners();}},250));
    setInterval(()=>{if(getUser()) pushStatus();}, Math.max(3,HEARTBEAT_SECONDS)*1000);
    setInterval(()=>{if(isExamActive() && SHOW_CAMERA_MONITOR && cameraReady) captureAndSendSnapshot("safety_interval");}, Math.max(90, SNAPSHOT_INTERVAL_SECONDS*2)*1000);
  }

  boot();
  window.PMB_REALTIME_DEBUG = () => ({firebaseReady, hasFirebaseConfig: hasFirebaseConfig(), participantCount: Object.keys(participants||{}).length, resultCount: Object.keys(realtimeResults||{}).length, localResultCount: readLocalResultsSafe().length, currentUser: getUser && getUser()});

  window.PMB_REALTIME_MONITOR = {pushStatus, ensureCamera, captureAndSendSnapshot, exportStatusCSV, exportResultsCSV};
})();
