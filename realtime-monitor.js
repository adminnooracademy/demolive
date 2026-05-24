/*
  realtime-monitor.js - FINAL STABLE
  - Realtime monitor Firebase
  - Camera draggable/minimize
  - Snapshot berkala
  - Refresh admin aman
  - Results are primarily pushed by app.js, this file also keeps status monitor alive
*/
(function(){
  const CFG = window.PMB_CONFIG || {};
  const ROOM = safeKey(CFG.realtimeRoomId || "pmb-stipi-2026");
  const HEARTBEAT_SECONDS = Number(CFG.heartbeatSeconds || 5);
  const ACTIVE_TIMEOUT_SECONDS = Number(CFG.activeTimeoutSeconds || 20);
  const REQUIRE_CAMERA = CFG.requireCameraBeforeExam !== false;
  const SHOW_CAMERA_MONITOR = CFG.showCameraMonitor !== false;
  const ENABLE_SNAPSHOTS = CFG.enableSnapshots !== false;
  const SNAPSHOT_INTERVAL_SECONDS = Math.max(45, Number(CFG.snapshotIntervalSeconds || 90));
  const SNAPSHOT_WIDTH = Number(CFG.snapshotWidth || 144);
  const SNAPSHOT_HEIGHT = Number(CFG.snapshotHeight || 108);
  const SNAPSHOT_QUALITY = Number(CFG.snapshotQuality || 0.28);

  let firebaseReady=false, db=null;
  let heartbeatTimer=null, snapshotTimer=null;
  let participants={}, realtimeResults={};
  let participantHandler=null, resultHandler=null;
  let cameraStream=null, cameraReady=false, snapshotCount=0, latestSnapshot="", latestSnapshotAt="";
  let lastPush=0;
  let dragState=null;
  const POS_KEY="pmb.cameraDockPosition";

  function safeKey(v){return String(v||"").replace(/[.#$/\[\]]/g,"-")}
  function esc(value){return String(value ?? "").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]))}
  function nowISO(){return new Date().toISOString()}
  function hasFirebaseConfig(){const c=CFG.firebaseConfig||{}; return Boolean(c.apiKey&&c.authDomain&&c.databaseURL&&c.projectId&&c.appId)}
  function pathBase(p=""){return `pmbRooms/${ROOM}${p?"/"+p:""}`}
  function pathParticipants(){return pathBase("participants")}
  function pathParticipant(username){return `${pathParticipants()}/${safeKey(username||"unknown")}`}
  function pathResults(){return pathBase("results")}
  function getUser(){try{return currentUser||null}catch(e){return null}}
  function getCurrentExam(){try{return currentExam||null}catch(e){return null}}
  function getCurrentExamKey(){try{return currentExamKey||""}catch(e){return ""}}
  function getAnswers(){try{return Array.isArray(answers)?answers:[]}catch(e){return []}}
  function getRemainingSeconds(){try{return Number(remainingSeconds||0)}catch(e){return 0}}
  function getLostFocus(){try{return Number(lostFocus||0)}catch(e){return 0}}
  function getPackage(){try{return typeof getUserPackage==="function"?getUserPackage():""}catch(e){return ""}}
  function getCompleted(){try{return typeof getCompletedExamsForUser==="function"?getCompletedExamsForUser():[]}catch(e){return []}}
  function getAllowed(){try{return typeof allowedExamsForUser==="function"?allowedExamsForUser():[]}catch(e){return []}}
  function isExamActive(){const exam=getCurrentExam(); const key=getCurrentExamKey(); try{return Boolean(exam&&key&&!examSubmitted)}catch(e){return Boolean(exam&&key)}}
  function answeredCount(){return getAnswers().filter(x=>x!==null&&x!==undefined).length}

  async function initFirebase(){
    if(!hasFirebaseConfig()) return false;
    try{
      if(!firebase.apps || !firebase.apps.length) firebase.initializeApp(CFG.firebaseConfig);
      db=firebase.database();
      if(CFG.useAnonymousAuth !== false && firebase.auth && !firebase.auth().currentUser){
        await firebase.auth().signInAnonymously();
      }
      firebaseReady=true;
      return true;
    }catch(err){
      console.warn("Firebase realtime gagal aktif:", err);
      firebaseReady=false;
      return false;
    }
  }

  function currentStatus(){
    const user=getUser();
    if(!user) return {};
    const active=isExamActive();
    const exam=getCurrentExam();
    const completed=getCompleted();
    const allowed=getAllowed();
    let status=user.role==="admin"?"admin":"online";
    if(user.role!=="admin"){
      if(active) status="working";
      else if(allowed.length && completed.length>=allowed.length) status="finished";
      else if(completed.length) status="partial_done";
    }
    return {
      username:user.username,
      name:user.name||user.username,
      role:user.role,
      online:true,
      status,
      cameraOn: SHOW_CAMERA_MONITOR ? Boolean(cameraReady) : null,
      activeExam:active,
      examKey:active?getCurrentExamKey():"",
      examTitle:active&&exam?exam.title:"",
      examPackage:getPackage(),
      answered:active?answeredCount():0,
      total:active&&exam?exam.questions.length:0,
      remainingSeconds:active?getRemainingSeconds():0,
      lostFocus:getLostFocus(),
      completedCount:completed.length,
      snapshotCount:SHOW_CAMERA_MONITOR&&ENABLE_SNAPSHOTS?snapshotCount:0,
      latestSnapshot:SHOW_CAMERA_MONITOR&&ENABLE_SNAPSHOTS?latestSnapshot:"",
      latestSnapshotAt:SHOW_CAMERA_MONITOR&&ENABLE_SNAPSHOTS?latestSnapshotAt:"",
      lastSeenMs:Date.now(),
      lastSeenISO:nowISO(),
      network:navigator.onLine?"online":"offline",
      tabHidden:document.hidden
    };
  }

  async function pushStatus(extra){
    const user=getUser();
    if(!firebaseReady||!db||!user) return;
    const now=Date.now();
    if(!extra && now-lastPush<900) return;
    lastPush=now;
    try{
      await db.ref(pathParticipant(user.username)).update(Object.assign(currentStatus(), extra||{}));
      db.ref(pathParticipant(user.username)).onDisconnect().update({
        online:false,status:"offline",cameraOn:false,activeExam:false,lastSeenMs:Date.now(),lastSeenISO:nowISO()
      });
    }catch(err){console.warn("Gagal push status:",err)}
  }

  function startHeartbeat(){stopHeartbeat(); heartbeatTimer=setInterval(()=>pushStatus(), Math.max(3,HEARTBEAT_SECONDS)*1000)}
  function stopHeartbeat(){if(heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer=null}

  function readPos(){try{return JSON.parse(localStorage.getItem(POS_KEY)||"null")}catch(e){return null}}
  function savePos(p){try{localStorage.setItem(POS_KEY,JSON.stringify(p))}catch(e){}}
  function clampPos(x,y,dock){
    const pad=8,w=dock.offsetWidth||220,h=dock.offsetHeight||150;
    return {x:Math.min(Math.max(pad,x),Math.max(pad,innerWidth-w-pad)), y:Math.min(Math.max(pad,y),Math.max(pad,innerHeight-h-pad))};
  }
  function applyPos(p){const dock=document.getElementById("realtimeCameraDock"); if(!dock||!p)return; const c=clampPos(p.x,p.y,dock); dock.style.left=c.x+"px"; dock.style.top=c.y+"px"; dock.style.right="auto"; dock.style.bottom="auto";}
  function resetPos(){const dock=document.getElementById("realtimeCameraDock"); if(!dock)return; dock.style.left=""; dock.style.top=""; dock.style.right=""; dock.style.bottom=""; localStorage.removeItem(POS_KEY)}
  function makeDraggable(){
    const dock=document.getElementById("realtimeCameraDock"), head=document.getElementById("realtimeCameraHead");
    if(!dock||!head||head.dataset.dragReady==="1") return;
    head.dataset.dragReady="1";
    head.addEventListener("pointerdown",e=>{if(e.target.closest("button"))return; const r=dock.getBoundingClientRect(); dragState={x:e.clientX-r.left,y:e.clientY-r.top}; dock.classList.add("dragging"); try{head.setPointerCapture(e.pointerId)}catch(err){} e.preventDefault();});
    head.addEventListener("pointermove",e=>{if(!dragState)return; const c=clampPos(e.clientX-dragState.x,e.clientY-dragState.y,dock); dock.style.left=c.x+"px"; dock.style.top=c.y+"px"; dock.style.right="auto"; dock.style.bottom="auto"; e.preventDefault();});
    const end=()=>{if(!dragState)return; dragState=null; dock.classList.remove("dragging"); const r=dock.getBoundingClientRect(); savePos({x:r.left,y:r.top});};
    head.addEventListener("pointerup",end); head.addEventListener("pointercancel",end); head.addEventListener("dblclick",resetPos);
    addEventListener("resize",()=>{const p=readPos(); if(p)setTimeout(()=>applyPos(p),60)});
  }

  function ensureCameraDock(){
    let dock=document.getElementById("realtimeCameraDock");
    if(dock) return dock;
    dock=document.createElement("aside");
    dock.id="realtimeCameraDock";
    dock.className="camera-dock hidden";
    dock.innerHTML=`<div class="camera-dock-head" id="realtimeCameraHead"><span class="camera-dot"></span><b>Kamera Aktif</b><span class="camera-drag-hint">Geser</span><button id="realtimeCameraMin" type="button">−</button></div><video id="realtimeCameraVideo" autoplay playsinline muted></video><p class="camera-note" id="realtimeCameraNote">Snapshot berkala aktif. Kotak kamera bisa digeser.</p>`;
    document.body.appendChild(dock);
    document.getElementById("realtimeCameraMin").addEventListener("click",()=>toggleMin());
    makeDraggable();
    const p=readPos(); if(p)setTimeout(()=>applyPos(p),50);
    return dock;
  }
  function toggleMin(force){
    const dock=document.getElementById("realtimeCameraDock"); if(!dock)return;
    const btn=document.getElementById("realtimeCameraMin");
    if(typeof force==="boolean") dock.classList.toggle("minimized",force); else dock.classList.toggle("minimized");
    if(btn)btn.textContent=dock.classList.contains("minimized")?"+":"−";
  }
  function showDock(){if(!SHOW_CAMERA_MONITOR)return; const dock=ensureCameraDock(); dock.classList.remove("hidden"); if(matchMedia("(max-width:760px)").matches)toggleMin(true); const p=readPos(); if(p)setTimeout(()=>applyPos(p),30)}
  function hideDock(){const dock=document.getElementById("realtimeCameraDock"); if(dock)dock.classList.add("hidden")}

  async function ensureCamera(){
    if(!SHOW_CAMERA_MONITOR) return true;
    if(!REQUIRE_CAMERA && !cameraStream) return true;
    if(cameraReady&&cameraStream){showDock(); startSnapshots(); await pushStatus({cameraOn:true,event:"camera_on"}); return true;}
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){await simpleModal("Kamera Tidak Didukung","Gunakan Chrome atau Edge terbaru."); return false;}
    try{
      cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:480},height:{ideal:360}},audio:false});
      cameraReady=true; showDock();
      const video=document.getElementById("realtimeCameraVideo"); if(video)video.srcObject=cameraStream;
      cameraStream.getVideoTracks().forEach(track=>track.addEventListener("ended",()=>{cameraReady=false; stopSnapshots(); pushStatus({cameraOn:false,event:"camera_stopped"});}));
      startSnapshots(); setTimeout(()=>captureSnapshot("camera_started"),1200); await pushStatus({cameraOn:true,event:"camera_on"}); return true;
    }catch(err){cameraReady=false; await pushStatus({cameraOn:false,event:"camera_denied"}); await simpleModal("Kamera Belum Diizinkan","Ujian membutuhkan kamera aktif. Izinkan kamera di browser lalu coba lagi."); return false;}
  }
  async function simpleModal(title,message){if(typeof showActionModal==="function") await showActionModal({title,message,confirmText:"Mengerti",hideCancel:true}); else alert(`${title}\n\n${message}`)}

  function startSnapshots(){if(!ENABLE_SNAPSHOTS||!cameraStream)return; stopSnapshots(); snapshotTimer=setInterval(()=>captureSnapshot("interval"), SNAPSHOT_INTERVAL_SECONDS*1000)}
  function stopSnapshots(){if(snapshotTimer)clearInterval(snapshotTimer); snapshotTimer=null}
  async function captureSnapshot(label){
    if(!ENABLE_SNAPSHOTS||!cameraReady||!db||!getUser())return;
    const video=document.getElementById("realtimeCameraVideo"); if(!video||video.readyState<2)return;
    try{
      const canvas=document.createElement("canvas"); canvas.width=SNAPSHOT_WIDTH; canvas.height=SNAPSHOT_HEIGHT;
      const ctx=canvas.getContext("2d"); ctx.translate(canvas.width,0); ctx.scale(-1,1); ctx.drawImage(video,0,0,canvas.width,canvas.height);
      latestSnapshot=canvas.toDataURL("image/jpeg",SNAPSHOT_QUALITY); latestSnapshotAt=nowISO(); snapshotCount++;
      await pushStatus({event:"snapshot",latestSnapshot,latestSnapshotAt,snapshotCount});
    }catch(err){console.warn("Snapshot gagal:",err)}
  }

  function installHooks(){
    if(typeof startExam==="function"&&!startExam.__finalHooked){
      const original=startExam;
      startExam=async function(key){const ok=await ensureCamera(); if(!ok)return; const res=await original.apply(this,arguments); pushStatus({event:"exam_started"}); return res;}
      startExam.__finalHooked=true;
    }
    if(typeof submitExam==="function"&&!submitExam.__finalHooked){
      const original=submitExam;
      submitExam=async function(auto){const res=await original.apply(this,arguments); stopSnapshots(); pushStatus({event:"exam_submitted",activeExam:false}); return res;}
      submitExam.__finalHooked=true;
    }
    if(typeof renderAdmin==="function"&&!renderAdmin.__finalHooked){
      const original=renderAdmin;
      renderAdmin=function(){const res=original.apply(this,arguments); ensureAdminRealtime(); startAdminListeners(); return res;}
      renderAdmin.__finalHooked=true;
    }
    if(typeof renderDashboard==="function"&&!renderDashboard.__finalHooked){
      const original=renderDashboard;
      renderDashboard=function(){const res=original.apply(this,arguments); pushStatus({event:"dashboard"}); return res;}
      renderDashboard.__finalHooked=true;
    }
  }

  function isActive(p){return Boolean(p.online)&&Date.now()-Number(p.lastSeenMs||0)<=ACTIVE_TIMEOUT_SECONDS*1000}
  function participantArray(){return Object.values(participants||{}).filter(p=>p&&p.role!=="admin").sort((a,b)=>String(a.username).localeCompare(String(b.username)))}
  function resultArray(){return Object.values(realtimeResults||{}).sort((a,b)=>String(b.submittedAt||"").localeCompare(String(a.submittedAt||"")))}
  function stats(){const arr=participantArray(),active=arr.filter(isActive); return {total:arr.length,active:active.length,cameraOn:active.filter(p=>p.cameraOn).length,working:active.filter(p=>p.status==="working").length,finished:arr.filter(p=>p.status==="finished").length,cameraProblem:active.filter(p=>p.status==="working"&&!p.cameraOn).length,lostFocus:arr.reduce((s,p)=>s+Number(p.lostFocus||0),0)}}
  function fmtSec(sec){sec=Number(sec||0); if(sec<=0)return "-"; return `${Math.floor(sec/60)}m ${String(sec%60).padStart(2,"0")}s`}
  function ago(ms){if(!ms)return "-"; const s=Math.floor((Date.now()-Number(ms))/1000); if(s<10)return"baru saja"; if(s<60)return`${s} detik lalu`; const m=Math.floor(s/60); return m<60?`${m} menit lalu`:`${Math.floor(m/60)} jam lalu`}
  function statusText(p){if(!isActive(p))return"Offline"; if(p.status==="working")return"Sedang ujian"; if(p.status==="finished")return"Selesai"; if(p.status==="partial_done")return"Sebagian selesai"; return"Online"}
  function dot(p){if(!isActive(p))return"offline"; if(p.status==="working"&&!p.cameraOn)return"bad"; if(p.status==="working")return"busy"; return"online"}
  function activity(p){if(!isActive(p))return"Tidak aktif"; if(p.status==="working")return"Sedang mengerjakan"; if(p.status==="finished")return"Sudah selesai"; if(p.status==="partial_done")return`Selesai ${p.completedCount||0} bagian`; return"Menunggu/memilih paket"}
  function snapshotCell(p){return p.latestSnapshot&&isActive(p)?`<img class="snapshot-thumb" src="${p.latestSnapshot}" alt="Snapshot"><span class="monitor-small">${esc(p.latestSnapshotAt||"")}</span>`:`<span class="monitor-badge warn">Belum ada</span>`}
  function participantRows(){const arr=participantArray(); if(!arr.length)return`<tr><td colspan="10">Belum ada peserta terhubung.</td></tr>`; return arr.map(p=>`<tr><td><span class="status-dot ${dot(p)}"></span>${esc(statusText(p))}</td><td><b>${esc(p.name||"-")}</b><span class="monitor-small">${esc(p.username||"-")}</span></td><td>${snapshotCell(p)}</td><td>${p.cameraOn&&isActive(p)?`<span class="monitor-badge ok">On</span>`:`<span class="monitor-badge bad">Off</span>`}<span class="monitor-small">Snapshot: ${esc(p.snapshotCount||0)}</span></td><td>${esc(activity(p))}<span class="monitor-small">${esc(p.examPackage||"")}</span></td><td>${esc(p.examTitle||"-")}<span class="monitor-small">${esc(p.examKey||"")}</span></td><td>${esc(p.answered||0)}/${esc(p.total||0)}</td><td>${esc(fmtSec(p.remainingSeconds))}</td><td>${esc(p.lostFocus||0)}</td><td>${esc(ago(p.lastSeenMs))}<span class="monitor-small">${esc(p.network||"")}</span></td></tr>`).join("")}
  function resultsRows(){const arr=resultArray(); if(!arr.length)return`<tr><td colspan="9">Belum ada hasil submit realtime.</td></tr>`; return arr.map(r=>`<tr><td><b>${esc(r.name||"-")}</b><span class="monitor-small">${esc(r.username||"-")}</span></td><td>${esc(r.examPackage||"-")}</td><td>${esc(r.examTitle||r.examKey||"-")}</td><td><b>${esc(r.score??"-")}</b></td><td>${esc(r.correct??"-")}/${esc(r.total??"-")}</td><td>${esc(r.wrong??"-")}</td><td>${esc(r.lostFocus||0)}</td><td>${esc(r.snapshotCount||0)}</td><td>${esc(r.submittedAt||"-")}</td></tr>`).join("")}
  function adminHTML(){if(!hasFirebaseConfig())return`<div class="realtime-warning">Firebase belum dikonfigurasi di config.js.</div>`; const s=stats(); return `<div class="realtime-head"><div><h2>Monitor Realtime Peserta</h2><p>Online, sedang ujian, progress, sisa waktu, kamera, dan snapshot berkala.</p></div><span class="monitor-badge ${firebaseReady?"ok":"warn"}">${firebaseReady?"Firebase aktif":"Menghubungkan"}</span></div><div class="realtime-kpis"><div class="realtime-kpi ok"><span>Aktif</span><b>${s.active}</b></div><div class="realtime-kpi ok"><span>On Camera</span><b>${s.cameraOn}</b></div><div class="realtime-kpi warn"><span>Sedang Ujian</span><b>${s.working}</b></div><div class="realtime-kpi"><span>Selesai</span><b>${s.finished}</b></div><div class="realtime-kpi bad"><span>Kamera Off</span><b>${s.cameraProblem}</b></div></div><div class="realtime-tools"><button class="btn btn-primary" id="realtimeRefresh" type="button">Refresh Monitor</button><button class="btn btn-soft" id="exportRealtimeStatus" type="button">Export Status CSV</button><button class="btn btn-ghost" id="exportRealtimeResults" type="button">Export Hasil CSV</button></div><div class="realtime-table-wrap"><table class="realtime-table"><thead><tr><th>Status</th><th>Peserta</th><th>Snapshot</th><th>Kamera</th><th>Aktivitas</th><th>Ujian</th><th>Progress</th><th>Sisa Waktu</th><th>Keluar Tab</th><th>Update</th></tr></thead><tbody>${participantRows()}</tbody></table></div><div class="realtime-head" style="margin-top:24px"><div><h2>Hasil Realtime</h2><p>Cadangan hasil dari Firebase. Rekap utama nilai juga tampil pada panel Hasil Ujian Peserta.</p></div><span class="monitor-badge ok">${resultArray().length} hasil</span></div><div class="realtime-table-wrap"><table class="realtime-table"><thead><tr><th>Peserta</th><th>Paket</th><th>Ujian</th><th>Nilai</th><th>Benar</th><th>Salah</th><th>Keluar Tab</th><th>Snapshot</th><th>Submit</th></tr></thead><tbody>${resultsRows()}</tbody></table></div>`}
  function ensureAdminRealtime(){const user=getUser(),d=document.getElementById("dashboard"); if(!user||user.role!=="admin"||!d)return; let p=document.getElementById("realtimeAdminPanel"); if(!p){p=document.createElement("section"); p.id="realtimeAdminPanel"; p.className="realtime-panel"; const target=document.querySelector(".admin-firebase-results")||d.firstElementChild; if(target)target.insertAdjacentElement("afterend",p); else d.appendChild(p);} p.innerHTML=adminHTML(); bindAdminButtons();}
  async function reloadAdminData(){if(firebaseReady&&db){const ps=await db.ref(pathParticipants()).once("value"); participants=ps.val()||{}; const rs=await db.ref(pathResults()).once("value"); realtimeResults=rs.val()||{};} ensureAdminRealtime(); if(typeof refreshFirebaseResultsPanel==="function") refreshFirebaseResultsPanel();}
  function bindAdminButtons(){const r=document.getElementById("realtimeRefresh"); if(r)r.onclick=async()=>{r.disabled=true; r.textContent="Memuat..."; await reloadAdminData(); const btn=document.getElementById("realtimeRefresh"); if(btn){btn.disabled=false; btn.textContent="Refresh Monitor";}}; const ex=document.getElementById("exportRealtimeStatus"); if(ex)ex.onclick=exportStatusCSV; const er=document.getElementById("exportRealtimeResults"); if(er)er.onclick=exportResultsCSV;}
  function startAdminListeners(){if(!firebaseReady||!db)return; if(participantHandler)db.ref(pathParticipants()).off("value",participantHandler); if(resultHandler)db.ref(pathResults()).off("value",resultHandler); participantHandler=s=>{participants=s.val()||{}; ensureAdminRealtime();}; resultHandler=s=>{realtimeResults=s.val()||{}; ensureAdminRealtime();}; db.ref(pathParticipants()).on("value",participantHandler); db.ref(pathResults()).on("value",resultHandler);}
  function csv(v){return `"${String(v??"").replace(/"/g,'""')}"`}
  function downloadCSV(name,rows){const blob=new Blob([rows.map(r=>r.map(csv).join(",")).join("\n")],{type:"text/csv;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000)}
  function exportStatusCSV(){const rows=[["username","name","status","online","cameraOn","activeExam","examPackage","examKey","examTitle","answered","total","remainingSeconds","lostFocus","snapshotCount","lastSeenISO","network"]]; participantArray().forEach(p=>rows.push([p.username,p.name,p.status,p.online,p.cameraOn,p.activeExam,p.examPackage,p.examKey,p.examTitle,p.answered,p.total,p.remainingSeconds,p.lostFocus,p.snapshotCount,p.lastSeenISO,p.network])); downloadCSV("status-realtime-pmb.csv",rows)}
  function exportResultsCSV(){const rows=[["id","username","name","package","exam","score","correct","wrong","total","startedAt","submittedAt","durationSeconds","autoSubmitted","lostFocus"]]; resultArray().forEach(r=>rows.push([r.id,r.username,r.name,r.examPackage||"",r.examTitle,r.score,r.correct,r.wrong,r.total,r.startedAt,r.submittedAt,r.durationSeconds,r.autoSubmitted,r.lostFocus])); downloadCSV("hasil-realtime-pmb.csv",rows)}

  async function boot(){
    installHooks();
    document.addEventListener("visibilitychange",()=>pushStatus({tabHidden:document.hidden,event:document.hidden?"tab_hidden":"tab_visible"}));
    addEventListener("online",()=>pushStatus({network:"online",event:"online"}));
    addEventListener("offline",()=>pushStatus({network:"offline",event:"offline"}));
    await initFirebase();
    installHooks();
    startHeartbeat();
    setInterval(()=>{installHooks(); pushStatus(); ensureAdminRealtime();},2500);
    setTimeout(()=>{ensureAdminRealtime(); startAdminListeners();},300);
    setTimeout(()=>{ensureAdminRealtime(); startAdminListeners();},1200);
    const loginForm=document.getElementById("loginForm");
    if(loginForm)loginForm.addEventListener("submit",()=>setTimeout(()=>{pushStatus({event:"login"}); ensureAdminRealtime(); startAdminListeners();},300));
  }

  window.PMB_REALTIME_DEBUG=()=>({firebaseReady,hasFirebaseConfig:hasFirebaseConfig(),participants:Object.keys(participants).length,results:Object.keys(realtimeResults).length,currentUser:getUser()});
  window.PMB_REALTIME_MONITOR={pushStatus,ensureCamera,reloadAdminData,exportStatusCSV,exportResultsCSV};
  boot();
})();
