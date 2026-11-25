import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, collection, addDoc, doc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, CURRENCY, LOCALE } from "./firebase-config.js";

/* ============================================================
   Helpers
   ============================================================ */
const $ = (s) => document.querySelector(s);

const money = (n) =>
  new Intl.NumberFormat(LOCALE, {
    style: "currency", currency: CURRENCY,
    minimumFractionDigits: 0, maximumFractionDigits: 2
  }).format(n || 0);

const pad = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMonthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Parse "YYYY-MM-DD" as a local date (avoids timezone shifts)
const parseDate = (str) => { const [y, m, d] = str.split("-").map(Number); return new Date(y, m - 1, d); };

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ============================================================
   Categories (color-coded)
   ============================================================ */
const DEFAULT_CATS = {
  Food:          { color: "#f97316", icon: "🍔" },
  Travel:        { color: "#0ea5e9", icon: "🚗" },
  Bills:         { color: "#8b5cf6", icon: "🧾" },
  Shopping:      { color: "#ec4899", icon: "🛍️" },
  Entertainment: { color: "#eab308", icon: "🎬" },
  Health:        { color: "#10b981", icon: "💊" },
  Others:        { color: "#64748b", icon: "📦" }
};
const PALETTE = ["#14b8a6", "#f43f5e", "#6366f1", "#84cc16", "#d946ef", "#06b6d4", "#fb923c", "#a855f7"];
function hashStr(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
const catColor = (n) => DEFAULT_CATS[n]?.color || PALETTE[hashStr(n.toLowerCase()) % PALETTE.length];
const catIcon = (n) => DEFAULT_CATS[n]?.icon || "🏷️";
const tint = (hex, a = 0.14) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
};

/* ============================================================
   Firebase init
   ============================================================ */
const configured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE");
let db = null;

function setStatus(state, text) {
  const el = $("#syncStatus");
  el.classList.remove("online", "error");
  if (state) el.classList.add(state);
  $("#syncText").textContent = text;
}

if (!configured) {
  $("#configBanner").classList.remove("hidden");
  setStatus("error", "Not configured");
} else {
  db = getFirestore(initializeApp(firebaseConfig));
}

/* ============================================================
   State
   ============================================================ */
let expenses = [];      // { id, category, amount, date, note }
let incomes = {};       // { "YYYY-MM": amount }
let chart = null;
let editingId = null;
const EXPANDED_DATES_KEY = "myExpense.expandedDates";

function loadExpandedDates() {
  try {
    const stored = localStorage.getItem(EXPANDED_DATES_KEY);
    if (!stored) return new Set();
    const dates = JSON.parse(stored);
    if (!Array.isArray(dates) || dates.some((date) => typeof date !== "string")) {
      throw new TypeError("Stored expanded dates must be an array of strings.");
    }
    return new Set(dates);
  } catch (error) {
    console.error("Could not load expanded dates.", error);
    toast("Could not restore expanded dates.", true);
    return new Set();
  }
}

let expandedDates = loadExpandedDates();

function saveExpandedDates() {
  try {
    localStorage.setItem(EXPANDED_DATES_KEY, JSON.stringify([...expandedDates]));
  } catch (error) {
    console.error("Could not save expanded dates.", error);
    toast("Could not save expanded dates.", true);
  }
}

function syncDayGroup(group) {
  const expanded = expandedDates.has(group.dataset.date);
  group.querySelector("[data-day-toggle]").setAttribute("aria-expanded", String(expanded));
  group.querySelector(".day-chevron").textContent = expanded ? "−" : "+";
  group.querySelector(".day-entries").hidden = !expanded;
}

function setDayExpanded(date, expanded) {
  if (expanded) expandedDates.add(date);
  else expandedDates.delete(date);
  saveExpandedDates();

  const group = [...$("#dayList").querySelectorAll(".day-group")]
    .find((item) => item.dataset.date === date);
  if (group) syncDayGroup(group);
}

function setAllDaysExpanded(expanded) {
  const groups = [...$("#dayList").querySelectorAll(".day-group")];
  expandedDates = new Set(expanded ? groups.map((group) => group.dataset.date) : []);
  saveExpandedDates();
  groups.forEach(syncDayGroup);
}

/* ============================================================
   Category <select> handling
   ============================================================ */
function knownCategories() {
  const set = new Set(Object.keys(DEFAULT_CATS));
  expenses.forEach((e) => set.add(e.category));
  return [...set];
}

function fillCategoryOptions() {
  $("#expenseCategories").innerHTML =
    knownCategories().map((category) => `<option value="${esc(category)}"></option>`).join("");
}

function resolveCategory(input) {
  const name = input.value.trim();
  // Re-use existing capitalisation if the category already exists
  const existing = knownCategories().find((c) => c.toLowerCase() === name.toLowerCase());
  return existing || name.charAt(0).toUpperCase() + name.slice(1);
}

/* ============================================================
   Firestore listeners
   ============================================================ */
function startListeners() {
  const now = new Date();
  const rangeStart = toDateStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const rangeEnd = toDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  // Last month + current month expenses (single-field range => no composite index needed)
  const q = query(collection(db, "expenses"), where("date", ">=", rangeStart), where("date", "<=", rangeEnd));
  onSnapshot(q, (snap) => {
    expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setStatus("online", "Live · synced");
    fillCategoryOptions();
    renderAll();
  }, (err) => {
    console.error(err);
    setStatus("error", "Sync error");
    toast("Could not read data. Check Firestore rules & config.", true);
  });

  onSnapshot(collection(db, "incomes"), (snap) => {
    incomes = {};
    snap.forEach((d) => { incomes[d.id] = Number(d.data().amount) || 0; });
    syncIncomeInput();
    renderAll();
  }, (err) => console.error(err));
}

/* ============================================================
   Rendering
   ============================================================ */
function sum(list) { return list.reduce((t, e) => t + Number(e.amount || 0), 0); }

function renderAll() {
  const now = new Date();
  const curKey = toMonthKey(now);
  const prevKey = toMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const todayStr = toDateStr(now);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = now.getDate();

  $("#monthLabel").textContent =
    now.toLocaleDateString("en-GB", { weekday: "long" }) + " " +
    now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const cur = expenses.filter((e) => e.date.startsWith(curKey) && e.date <= todayStr);
  const prev = expenses.filter((e) => e.date.startsWith(prevKey));

  const income = incomes[curKey] || 0;
  const spent = sum(cur);
  const remaining = income - spent;
  const lastSpent = sum(prev);
  const lastSamePeriod = sum(prev.filter((e) => Number(e.date.slice(8, 10)) <= today));

  /* ---- Summary cards ---- */
  $("#incomeValue").textContent = money(income);
  $("#incomeSub").textContent = income ? "Received this month" : "Add your income below ↓";

  $("#spentValue").textContent = money(spent);
  const avg = today ? spent / today : 0;
  $("#spentSub").textContent = `Avg ${money(avg)}/day · ${cur.length} entr${cur.length === 1 ? "y" : "ies"}`;

  $("#remainingValue").textContent = money(remaining);
  const pct = income > 0 ? (spent / income) * 100 : (spent > 0 ? 100 : 0);
  const bar = $("#progressBar");
  bar.style.width = Math.min(pct, 100) + "%";
  bar.style.background = pct >= 100 ? "var(--red)" : pct >= 75 ? "var(--amber)" : "var(--green)";
  const rc = $("#remainingCard");
  rc.classList.toggle("negative", remaining < 0);
  rc.classList.toggle("warning", remaining >= 0 && income > 0 && pct >= 75);

  const daysLeft = daysInMonth - today + 1;
  if (!income) {
    $("#remainingSub").textContent = "Set income to see your balance";
  } else if (remaining < 0) {
    $("#remainingSub").innerHTML = `<span class="bad">Over budget by ${money(-remaining)}</span>`;
  } else {
    $("#remainingSub").innerHTML = `${pct.toFixed(0)}% used · safe to spend <b>${money(remaining / daysLeft)}</b>/day`;
  }

  $("#lastValue").textContent = money(lastSpent);
  if (!prev.length) {
    $("#lastSub").textContent = "No data for last month";
  } else {
    const diff = spent - lastSamePeriod;
    if (diff < 0) $("#lastSub").innerHTML = `<span class="good">▼ ${money(-diff)} less</span> than same period last month`;
    else if (diff > 0) $("#lastSub").innerHTML = `<span class="bad">▲ ${money(diff)} more</span> than same period last month`;
    else $("#lastSub").textContent = "Same as this point last month";
  }

  /* ---- Category analysis ---- */
  const totals = {};
  cur.forEach((e) => { totals[e.category] = (totals[e.category] || 0) + Number(e.amount); });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  renderHighLow(entries, spent);
  renderChart(entries, spent);

  /* ---- Day list ---- */
  renderDayList(cur, todayStr, spent);
}

function renderHighLow(entries, spent) {
  const set = (p, name, amt, note) => {
    $(`#${p}Name`).innerHTML = name; $(`#${p}Amount`).textContent = amt; $(`#${p}Note`).textContent = note;
  };
  if (!entries.length) {
    set("high", "—", "", "No spending yet");
    set("low", "—", "", "No spending yet");
    return;
  }
  const [hn, ha] = entries[0];
  const [ln, la] = entries[entries.length - 1];
  set("high", `${catIcon(hn)} ${esc(hn)}`, money(ha), `${((ha / spent) * 100).toFixed(0)}% of this month's spending — review it first`);
  if (entries.length === 1) set("low", "—", "", "Only one category so far");
  else set("low", `${catIcon(ln)} ${esc(ln)}`, money(la), `${((la / spent) * 100).toFixed(0)}% of this month's spending`);
}

const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chartInstance) {
    const dataset = chartInstance.data.datasets[0];
    if (!dataset) return;

    const { ctx } = chartInstance;
    const bars = chartInstance.getDatasetMeta(0).data;
    ctx.save();
    ctx.font = "600 11px Inter, sans-serif";
    ctx.fillStyle = "#4a5168";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    bars.forEach((bar, index) => {
      const value = Number(dataset.data[index]);
      if (!Number.isFinite(value)) return;
      const { x, y } = bar.getProps(["x", "y"], true);
      ctx.fillText(money(value), x, y - 6);
    });
    ctx.restore();
  }
};

function renderChart(entries, spent) {
  const labels = entries.map((e) => e[0]);
  const data = entries.map((e) => e[1]);
  const colors = labels.map(catColor);
  const empty = !entries.length;
  $("#chartEmpty").classList.toggle("hidden", !empty);
  $(".chart-wrap").style.height = "320px";

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].backgroundColor = colors;
    chart.update();
  } else {
    chart = new Chart($("#catChart"), {
      type: "bar",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 42 }] },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 12 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            callbacks: {
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((sum, value) => sum + Number(value || 0), 0);
                return ` ${money(ctx.parsed.y)} (${(total ? (ctx.parsed.y / total) * 100 : 0).toFixed(1)}%)`;
              }
            }
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 }
          },
          y: {
            beginAtZero: true,
            grace: "18%",
            grid: { color: "#eef0f6" },
            ticks: { callback: (value) => money(value) }
          }
        }
      },
      plugins: [valueLabels]
    });
  }

  $("#legend").innerHTML = entries.map(([n, v]) =>
    `<li><span class="sw" style="background:${catColor(n)}"></span><span class="nm">${catIcon(n)} ${esc(n)}</span><span class="pc">${((v / spent) * 100).toFixed(0)}% · ${money(v)}</span></li>`
  ).join("");
}

function renderDayList(cur, todayStr, spent) {
  const box = $("#dayList");
  $("#listSummary").textContent = cur.length ? `${cur.length} expense${cur.length === 1 ? "" : "s"} · ${money(spent)}` : "";
  if (!cur.length) {
    box.innerHTML = `<div class="empty-state"><div class="big">🗒️</div>No expenses recorded this month yet.<br>Add your first one using the form.</div>`;
    return;
  }
  const groups = {};
  cur.forEach((e) => (groups[e.date] = groups[e.date] || []).push(e));
  const days = Object.keys(groups).sort().reverse();

  box.innerHTML = days.map((d) => {
    const list = groups[d].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    const label = parseDate(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    const expanded = expandedDates.has(d);
    const rows = list.map((e) => {
      const c = catColor(e.category);
      return `
        <div class="exp-row">
          <div class="exp-icon" style="background:${tint(c)}">${catIcon(e.category)}</div>
          <div class="exp-main">
            <div class="exp-cat">${esc(e.category)}<span class="tag" style="background:${tint(c, .15)};color:${c}">${esc(e.category)}</span></div>
            <div class="exp-note">${esc(e.note) || "—"}</div>
          </div>
          <div class="exp-amount">${money(e.amount)}</div>
          <div class="exp-actions">
            <button class="icon-btn" data-edit="${e.id}" title="Edit">✏️</button>
            <button class="icon-btn del" data-del="${e.id}" title="Delete">🗑️</button>
          </div>
        </div>`;
    }).join("");
    return `
      <div class="day-group" data-date="${esc(d)}">
        <button type="button" class="day-head" data-day-toggle aria-expanded="${expanded}">
          <span class="day-title">
            <span>${label}${d === todayStr ? '<span class="today-tag">TODAY</span>' : ""}</span>
            <span class="day-chevron" aria-hidden="true">${expanded ? "−" : "+"}</span>
          </span>
          <span class="day-total">${money(sum(list))}</span>
        </button>
        <div class="day-entries" ${expanded ? "" : "hidden"}>${rows}</div>
      </div>`;
  }).join("");
}

$("#expandAllDays").addEventListener("click", () => setAllDaysExpanded(true));
$("#collapseAllDays").addEventListener("click", () => setAllDaysExpanded(false));

/* ============================================================
   Add expense
   ============================================================ */
const expCat = $("#expCategory");

function resetExpenseForm() {
  $("#expAmount").value = "";
  $("#expNote").value = "";
  $("#expDate").max = toDateStr(new Date());
  fillCategoryOptions();
}
$("#expDate").value = toDateStr(new Date());
resetExpenseForm();

$("#expenseForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!db) return toast("Add your Firebase config first.", true);
  const category = resolveCategory(expCat);
  const amount = parseFloat($("#expAmount").value);
  const expenseDate = $("#expDate").value;
  if (!category || !(amount > 0)) return toast("Enter a valid category and amount.", true);

  const btn = $("#expSubmit"); btn.disabled = true;
  try {
    await addDoc(collection(db, "expenses"), {
      category, amount,
      date: expenseDate,
      note: $("#expNote").value.trim(),
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });
    setDayExpanded(expenseDate, true);
    toast("Expense added ✓");
    resetExpenseForm();
  } catch (e) {
    console.error(e); toast("Failed to save expense.", true);
  } finally { btn.disabled = false; }
});

/* ============================================================
   Monthly income
   ============================================================ */
$("#incMonth").value = toMonthKey(new Date());
function syncIncomeInput() {
  const key = $("#incMonth").value;
  if (document.activeElement !== $("#incAmount")) $("#incAmount").value = incomes[key] ?? "";
}
$("#incMonth").addEventListener("change", () => { $("#incAmount").value = incomes[$("#incMonth").value] ?? ""; });

$("#incomeForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!db) return toast("Add your Firebase config first.", true);
  const month = $("#incMonth").value;
  const amount = parseFloat($("#incAmount").value);
  if (!month || !(amount >= 0)) return toast("Enter a valid month and amount.", true);
  try {
    await setDoc(doc(db, "incomes", month), { month, amount, updatedAt: serverTimestamp() });
    toast("Income saved ✓");
  } catch (e) {
    console.error(e); toast("Failed to save income.", true);
  }
});

/* ============================================================
   Edit / delete
   ============================================================ */
const editCat = $("#editCategory");

$("#dayList").addEventListener("click", async (ev) => {
  const dayToggle = ev.target.closest("[data-day-toggle]");
  const editBtn = ev.target.closest("[data-edit]");
  const delBtn = ev.target.closest("[data-del]");
  if (dayToggle) {
    const date = dayToggle.closest(".day-group").dataset.date;
    setDayExpanded(date, !expandedDates.has(date));
    return;
  }
  if (editBtn) openEdit(editBtn.dataset.edit);
  if (delBtn) {
    const e = expenses.find((x) => x.id === delBtn.dataset.del);
    if (!e) return;
    if (!confirm(`Delete this ${e.category} expense of ${money(e.amount)}?`)) return;
    try { await deleteDoc(doc(db, "expenses", e.id)); toast("Deleted"); }
    catch (err) { console.error(err); toast("Delete failed.", true); }
  }
});

function openEdit(id) {
  const e = expenses.find((x) => x.id === id);
  if (!e) return;
  editingId = id;
  fillCategoryOptions();
  editCat.value = e.category;
  $("#editAmount").value = e.amount;
  $("#editDate").value = e.date;
  $("#editDate").max = toDateStr(new Date());
  $("#editNote").value = e.note || "";
  $("#editModal").classList.remove("hidden");
}
const closeEdit = () => { $("#editModal").classList.add("hidden"); editingId = null; };
$("#editCancel").addEventListener("click", closeEdit);
$("#editModal").addEventListener("click", (ev) => { if (ev.target.id === "editModal") closeEdit(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeEdit(); });

$("#editForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!editingId) return;
  const category = resolveCategory(editCat);
  const amount = parseFloat($("#editAmount").value);
  const expenseDate = $("#editDate").value;
  if (!category || !(amount > 0)) return toast("Enter a valid category and amount.", true);
  try {
    await updateDoc(doc(db, "expenses", editingId), {
      category, amount, date: expenseDate, note: $("#editNote").value.trim()
    });
    setDayExpanded(expenseDate, true);
    toast("Expense updated ✓");
    closeEdit();
  } catch (e) { console.error(e); toast("Update failed.", true); }
});

/* ============================================================
   Go
   ============================================================ */
renderAll();
if (db) { setStatus("", "Connecting…"); startListeners(); }
