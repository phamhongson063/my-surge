const SERVER = "http://localhost:3000";
const CONCURRENT_LIMIT = 5;
let isStopping = false;

window.onload = () => {
  const endInput = document.getElementById("endDate");
  if (endInput) endInput.value = new Date().toISOString().slice(0, 10);
  checkServer();
  setInterval(checkServer, 5000);
};

async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/health`);
    const pill = document.getElementById("serverPill");
    if (res.ok && pill) {
      pill.innerHTML = `<span class="w-3 h-3 rounded-full bg-emerald-400 shadow-[0_0_15px_#10b981]"></span>
                             <span class="text-sm font-black uppercase tracking-widest text-emerald-400">ONLINE</span>`;
      pill.className =
        "px-6 py-3 rounded-2xl bg-emerald-950/30 border-2 border-emerald-500/30 flex items-center gap-3 shadow-2xl";
    }
  } catch (e) {
    const pill = document.getElementById("serverPill");
    if (pill) {
      pill.innerHTML = `<span class="w-3 h-3 rounded-full bg-red-500 animate-pulse"></span>
                             <span class="text-sm font-black uppercase tracking-widest text-red-500">OFFLINE</span>`;
      pill.className =
        "px-6 py-3 rounded-2xl bg-red-950/30 border-2 border-red-500/30 flex items-center gap-3 shadow-2xl";
    }
  }
}

function addLog(type, msg, id = null) {
  const log = document.getElementById("log");
  if (!log) return;
  let row = id ? document.getElementById(`log-${id}`) : null;

  if (!row) {
    row = document.createElement("div");
    if (id) row.id = `log-${id}`;
    log.appendChild(row);
  }

  const colors = {
    success: "text-emerald-400",
    error: "text-red-400",
    info: "text-sky-400",
    warn: "text-amber-400",
  };

  const colorClass = colors[type] || "text-white";
  row.className = "flex gap-6 py-2 border-b border-white/5 items-start text-xl";
  row.innerHTML = `<span class="text-slate-700 font-mono text-sm pt-1.5 shrink-0">${new Date().toLocaleTimeString()}</span>
                     <span class="${colorClass} font-bold leading-tight">${msg}</span>`;
  log.scrollTop = log.scrollHeight;
}

function stopDownload() {
  isStopping = true;
  const btnStop = document.getElementById("btnStop");
  if (btnStop) {
    btnStop.innerHTML = '<span class="text-xs font-black">STOPPING...</span>';
    btnStop.disabled = true;
  }
  addLog("warn", "⚠ Đang dừng hệ thống...");
}

async function downloadTask(sym, start, end) {
  try {
    const res = await fetch(
      `${SERVER}/download?symbol=${sym}&start=${start}&end=${end}`
    );
    const data = await res.json();
    return { sym, ok: data.ok || data.success };
  } catch (e) {
    return { sym, ok: false };
  }
}

async function doDownloadAll() {
  clearLog();
  const btnAll = document.getElementById("btnDownloadAll");
  const btnStop = document.getElementById("btnStop");
  const progCont = document.getElementById("progressContainer");
  const spinner = document.getElementById("spinnerIcon"); // Lấy thẻ bánh xe

  try {
    isStopping = false; // Reset trạng thái dừng

    // 1. Đọc danh sách mã chứng khoán
    const resCsv = await fetch("/stocks.csv");
    if (!resCsv.ok) throw new Error("Không tìm thấy stocks.csv trên server");
    const text = await resCsv.text();
    const stocks = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase() !== "symbol");

    // 2. Kích hoạt giao diện tải
    if (progCont) progCont.classList.remove("hidden");
    if (btnAll) btnAll.classList.add("hidden");
    if (spinner) spinner.classList.add("animate-spin"); // BẮT ĐẦU XOAY

    if (btnStop) {
      btnStop.classList.remove("hidden");
      btnStop.disabled = false;
      btnStop.innerHTML =
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    }

    // 3. Chuẩn bị tham số thời gian
    const start = document
      .getElementById("startDate")
      .value.split("-")
      .reverse()
      .join("/");
    const end = document
      .getElementById("endDate")
      .value.split("-")
      .reverse()
      .join("/");
    let completed = 0,
      success = 0;
    const pool = new Set();

    addLog("info", `🚀 BẮT ĐẦU: Xử lý ${stocks.length} mã chứng khoán`);

    // 4. Vòng lặp tải dữ liệu
    for (const sym of stocks) {
      if (isStopping) break; // Dừng vòng lặp nếu bấm nút STOP

      if (pool.size >= CONCURRENT_LIMIT) await Promise.race(pool);

      const promise = downloadTask(sym, start, end).then((res) => {
        completed++;
        if (res.ok) success++;

        // Cập nhật thanh tiến độ
        const p = Math.round((completed / stocks.length) * 100);
        document.getElementById("progressFill").style.width = p + "%";
        document.getElementById("progressPercent").innerText = p + "%";
        document.getElementById(
          "progressLabel"
        ).innerText = `ĐANG TẢI: ${res.sym}`;

        addLog(
          "warn",
          `⚡ TIẾN ĐỘ: ${completed}/${stocks.length} | OK: ${success}`,
          "batch-status"
        );
        pool.delete(promise);
      });
      pool.add(promise);
    }

    await Promise.all(pool);
    addLog(
      "success",
      isStopping
        ? `🏁 ĐÃ DỪNG TẠI ${completed} MÃ.`
        : `✔ HOÀN TẤT TOÀN BỘ ${stocks.length} MÃ.`
    );
  } catch (e) {
    addLog("error", "LỖI HỆ THỐNG: " + e.message);
  } finally {
    // 5. DỌN DẸP GIAO DIỆN (Luôn chạy dù thành công hay lỗi)
    if (btnAll) btnAll.classList.remove("hidden");
    if (btnStop) btnStop.classList.add("hidden");
    if (spinner) spinner.classList.remove("animate-spin"); // DỪNG BÁNH XE XOAY

    // Đặt lại tên nhãn tiến độ
    const label = document.getElementById("progressLabel");
    if (label) label.innerText = isStopping ? "Đã tạm dừng" : "Hoàn tất xử lý";
  }
}

function clearLog() {
  document.getElementById("log").innerHTML =
    '<div class="text-slate-600 italic">// Console cleared.</div>';
}

function showInputError() {
  const alertBox = document.getElementById("errorAlert");
  const input = document.getElementById("symbolInput");

  // Hiệu ứng cho ô Input
  input.classList.add("border-red-500", "animate-pulse");

  // Hiệu ứng cho Alert Box (Trượt xuống + Hiện hình)
  alertBox.classList.remove(
    "opacity-0",
    "-translate-y-10",
    "pointer-events-none"
  );
  alertBox.classList.add("opacity-100", "translate-y-0");

  // Sau 2.5 giây tự động ẩn đi mượt mà
  setTimeout(() => {
    input.classList.remove("border-red-500", "animate-pulse");

    alertBox.classList.add(
      "opacity-0",
      "-translate-y-10",
      "pointer-events-none"
    );
    alertBox.classList.remove("opacity-100", "translate-y-0");
  }, 2500);
}

// Cập nhật lại hàm doDownload của bạn
async function doDownload() {
  const symInput = document.getElementById("symbolInput");
  const sym = symInput.value.trim().toUpperCase();

  // Kiểm tra nếu chưa nhập mã
  if (!sym) {
    showInputError(); // Gọi thông báo smooth
    return;
  }

  clearLog(); // Xóa log cũ như bạn muốn
  addLog("info", `⏳ ĐANG TẢI ${sym}...`);

  const start = document
    .getElementById("startDate")
    .value.split("-")
    .reverse()
    .join("/");
  const end = document
    .getElementById("endDate")
    .value.split("-")
    .reverse()
    .join("/");

  const res = await downloadTask(sym, start, end);
  if (res.ok) addLog("success", `✔ MÃ ${sym}: TẢI THÀNH CÔNG`);
  else addLog("error", `✖ MÃ ${sym}: THẤT BẠI`);
}
