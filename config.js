window.PMB_CONFIG = {
  // Opsional: isi URL Google Apps Script jika ingin hasil juga masuk Google Sheets.
  sheetsWebAppUrl: "",

  // Room ujian. Ganti kalau ingin pisah sesi/gelombang.
  realtimeRoomId: "pmb-stipi-2026",

  // WAJIB DIISI agar admin bisa pantau realtime.
  // Ambil dari Firebase Console > Project settings > Your apps > Web app.
  firebaseConfig: {
    apiKey: "",
    authDomain: "",
    databaseURL: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  },

  // Biarkan true. Aktifkan Anonymous di Firebase Authentication.
  useAnonymousAuth: true,

  // Pengaturan monitoring
  heartbeatSeconds: 5,
  activeTimeoutSeconds: 20,
  requireCameraBeforeExam: true
};
