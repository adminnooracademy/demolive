function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Hasil PMB') || ss.insertSheet('Hasil PMB');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['ID','Username','Nama','Ujian','Nilai','Benar','Salah/Kosong','Total','Mulai','Submit','Durasi Detik','Auto Submit','Tab Keluar','Detail JSON']);
  }
  const data = JSON.parse(e.postData.contents);
  sheet.appendRow([
    data.id,
    data.username,
    data.name,
    data.examTitle,
    data.score,
    data.correct,
    data.wrong,
    data.total,
    data.startedAt,
    data.submittedAt,
    data.durationSeconds,
    data.autoSubmitted,
    data.lostFocus,
    JSON.stringify(data.details)
  ]);
  return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
}
