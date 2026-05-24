window.PMB_CONFIG = {
  // Opsional: isi URL Google Apps Script jika ingin hasil juga masuk Google Sheets.
  sheetsWebAppUrl: "",

  // Room ujian. Ganti kalau ingin pisah sesi/gelombang.
  realtimeRoomId: "pmb-stipi-2026",

  // WAJIB DIISI agar admin bisa pantau realtime.
  // Ambil dari Firebase Console > Project settings > Your apps > Web app.
  firebaseConfig: {
   apiKey: "AIzaSyDOBfe4INgVtimBkwVgfQSHT8nkOS-RL0M",
   authDomain: "demolive-45286.firebaseapp.com",
   projectId: "demolive-45286",
   storageBucket: "demolive-45286.firebasestorage.app",
   messagingSenderId: "809618354310",
   appId: "1:809618354310:web:c3ef1ec39ce90320566107",
  },

  // Biarkan true. Aktifkan Anonymous di Firebase Authentication.
  useAnonymousAuth: true,

  // Pengaturan monitoring
  heartbeatSeconds: 5,
  activeTimeoutSeconds: 20,
  requireCameraBeforeExam: true
};
