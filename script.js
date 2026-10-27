(() => {
  "use strict";

  const STORAGE_KEY = "spendwise.data.v1";
  const DEFAULTS = [
    ["Food & Dining", "expense", "🍽️", "#f59e0b"],
    ["Transportation", "expense", "🚗", "#3b82f6"],
    ["Shopping", "expense", "🛍️", "#ec4899"],
    ["Bills & Utilities", "expense", "⚡", "#8b5cf6"],
    ["Health", "expense", "💚", "#10b981"],
    ["Education", "expense", "📚", "#06b6d4"],
    ["Entertainment", "expense", "🎬", "#f97316"],
    ["Salary", "income", "💼", "#10b981"],
    ["Freelance", "income", "✨", "#6366f1"],
    ["Other", "expense", "✦", "#64748b"],
  ];
  const CURRENCIES = { INR: ["₹", "en-IN"], USD: ["$", "en-US"], EUR: ["€", "de-DE"], GBP: ["£", "en-GB"] };
  const PAGE_NAMES = { dashboard: "Dashboard", transactions: "Transactions", "transaction-form": "Add transaction", categories: "Manage categories", "category-form": "Category details", budgets: "Budgets", "budget-form": "Budget details", reports: "Reports", settings: "Settings" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const content = $("#pageContent");
  const backdrop = $("#modalBackdrop");
  const dialog = $("#dialog");
  let state;
  let currentPage = "dashboard";
  let focusBeforeDialog = null;
  let charts = [];
  let pageFilters = {};
  let storageWarning = false;
  let savedSnapshot = "";

  function uid() {
    return globalThis.crypto?.randomUUID?.() || `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  }

  function createDefaults() {
    const now = new Date();
    return {
      version: 1,
      categories: DEFAULTS.map(([name, type, icon, color]) => ({ id: uid(), name, type, icon, color, description: "", archived: false, createdAt: now.toISOString() })),
      transactions: [],
      budgets: [],
      preferences: { currency: "USD", theme: "light", warningThreshold: 80 },
    };
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function validRecordCollection(value, fields) {
    return Array.isArray(value) && value.every((record) => isPlainObject(record) && fields.every((field) => Object.hasOwn(record, field)));
  }

  function validateData(value) {
    if (!isPlainObject(value) || value.version !== 1) throw new Error("This backup has an unsupported format.");
    if (!validRecordCollection(value.categories, ["id", "name", "type", "icon", "color", "description", "archived"])) throw new Error("Backup categories are invalid.");
    if (!validRecordCollection(value.transactions, ["id", "title", "amount", "type", "categoryId", "date", "paymentMethod", "notes"])) throw new Error("Backup transactions are invalid.");
    if (!validRecordCollection(value.budgets, ["id", "type", "categoryId", "month", "amount"])) throw new Error("Backup budgets are invalid.");
    if (!isPlainObject(value.preferences) || !["INR", "USD", "EUR", "GBP"].includes(value.preferences.currency) ||
        !["light", "dark"].includes(value.preferences.theme) || !Number.isFinite(Number(value.preferences.warningThreshold)) ||
        Number(value.preferences.warningThreshold) < 1 || Number(value.preferences.warningThreshold) > 100) {
      throw new Error("Backup preferences are invalid.");
    }

    const ids = new Set();
    const categoryNames = new Set();
    const categoryById = new Map();
    value.categories.forEach((category) => {
      if (typeof category.id !== "string" || !category.id || ids.has(category.id) ||
          typeof category.name !== "string" || !category.name.trim() ||
          !["income", "expense"].includes(category.type) || typeof category.icon !== "string" ||
          !/^#[0-9a-f]{6}$/i.test(category.color) || typeof category.description !== "string" ||
          typeof category.archived !== "boolean") throw new Error("A category in this backup is invalid.");
      ids.add(category.id);
      categoryById.set(category.id, category);
      const key = `${category.type}:${category.name.trim().toLocaleLowerCase()}`;
      if (categoryNames.has(key)) throw new Error("This backup contains duplicate category names of the same type.");
      categoryNames.add(key);
    });

    const transactionIds = new Set();
    value.transactions.forEach((transaction) => {
      const amount = Number(transaction.amount);
      const category = categoryById.get(transaction.categoryId);
      if (typeof transaction.id !== "string" || !transaction.id || ids.has(transaction.id) || transactionIds.has(transaction.id) ||
          typeof transaction.title !== "string" || !transaction.title.trim() ||
          !Number.isFinite(amount) || amount <= 0 ||
          !["income", "expense"].includes(transaction.type) || !category ||
          category.type !== transaction.type || !isValidDate(transaction.date) ||
          typeof transaction.paymentMethod !== "string" || !transaction.paymentMethod.trim() || typeof transaction.notes !== "string") {
        throw new Error("A transaction in this backup is invalid or references a missing category.");
      }
      transactionIds.add(transaction.id);
      ids.add(transaction.id);
    });

    const budgetKeys = new Set();
    value.budgets.forEach((budget) => {
      const amount = Number(budget.amount);
      const overall = budget.type === "overall" && budget.categoryId === null;
      const category = categoryById.get(budget.categoryId);
      if (typeof budget.id !== "string" || !budget.id || ids.has(budget.id) || transactionIds.has(budget.id) ||
          !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}$/.test(budget.month) ||
          !isValidMonth(budget.month) ||
          !(overall || (budget.type === "category" && category && category.type === "expense"))) {
        throw new Error("A budget in this backup is invalid.");
      }
      const key = `${budget.month}:${budget.categoryId || "overall"}`;
      if (budgetKeys.has(key)) throw new Error("This backup contains duplicate budgets for the same month.");
      budgetKeys.add(key);
      ids.add(budget.id);
    });

    return {
      version: 1,
      categories: value.categories.map((item) => ({ ...item, name: item.name.trim() })),
      transactions: value.transactions.map((item) => ({ ...item, amount: Number(item.amount), title: item.title.trim() })),
      budgets: value.budgets.map((item) => ({ ...item, amount: Number(item.amount) })),
      preferences: {
        currency: value.preferences.currency,
        theme: value.preferences.theme,
        warningThreshold: Number(value.preferences.warningThreshold),
      },
    };
  }

  function isValidDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime()) &&
      localISO(new Date(`${value}T12:00:00`)) === value;
  }

  function localISO(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function isValidMonth(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
    const month = Number(value.slice(5, 7));
    return month >= 1 && month <= 12;
  }

  function readData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaults();
      return validateData(JSON.parse(raw));
    } catch (error) {
      storageWarning = true;
      try {
        localStorage.setItem(`${STORAGE_KEY}.corrupt.${Date.now()}`, localStorage.getItem(STORAGE_KEY) || "");
      } catch {
        // The readable app still works with in-memory defaults when storage is disabled.
      }
      return createDefaults();
    }
  }

  function save() {
    try {
      const snapshot = JSON.stringify(state);
      localStorage.setItem(STORAGE_KEY, snapshot);
      savedSnapshot = snapshot;
      storageWarning = false;
      return true;
    } catch (error) {
      if (savedSnapshot) state = JSON.parse(savedSnapshot);
      showToast("Could not save data in browser storage. Check available storage space or permissions.", true);
      return false;
    }
  }

  function h(tag, attrs = {}, children = []) {
    const element = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === null || value === undefined || value === false) return;
      if (key === "className") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key === "htmlFor") element.htmlFor = value;
      else if (key === "style" && isPlainObject(value)) {
        Object.entries(value).forEach(([property, setting]) => {
          if (property.startsWith("--")) element.style.setProperty(property, setting);
          else element.style[property] = setting;
        });
      }
      else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in element && !key.startsWith("aria-") && !key.startsWith("data-")) element[key] = value;
      else element.setAttribute(key, value === true ? "" : value);
    });
    (Array.isArray(children) ? children : [children]).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return element;
  }

  function append(parent, ...children) {
    children.flat(Infinity).forEach((child) => {
      if (child !== null && child !== undefined && child !== false) parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return parent;
  }

  function button(label, className = "button-secondary", attrs = {}) {
    if (typeof attrs === "function") attrs = { onclick: attrs };
    return h("button", { type: "button", className, ...attrs }, label);
  }

  function formatMoney(value, digits = 2) {
    const [symbol, locale] = CURRENCIES[state.preferences.currency] || CURRENCIES.USD;
    const amount = Number(value) || 0;
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: state.preferences.currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
    } catch {
      return `${symbol}${amount.toFixed(digits)}`;
    }
  }

  function showToast(message, error = false) {
    const region = $("#toastRegion");
    const toast = h("div", { className: `toast${error ? " error" : ""}`, role: "status", text: message });
    region.append(toast);
    window.setTimeout(() => toast.remove(), 3900);
  }

  function todayISO() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function localDate(value) {
    return new Date(`${value}T12:00:00`);
  }

  function dateLabel(value, options = { month: "short", day: "numeric", year: "numeric" }) {
    return localDate(value).toLocaleDateString(undefined, options);
  }

  function monthBounds(month = monthKey()) {
    const [year, monthNumber] = month.split("-").map(Number);
    return {
      start: `${year}-${String(monthNumber).padStart(2, "0")}-01`,
      end: `${year}-${String(monthNumber).padStart(2, "0")}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`,
    };
  }

  function categoryById(id) {
    return state.categories.find((category) => category.id === id);
  }

  function getPageRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    if (!hash) return { page: "dashboard" };
    const [page, id] = hash.split("/");
    if (page === "transaction-edit" && id) return { page: "transaction-form", id };
    if (page === "category-edit" && id) return { page: "category-form", id };
    if (page === "budget-edit" && id) return { page: "budget-form", id };
    return { page: PAGE_NAMES[page] ? page : "dashboard" };
  }

  function navigate(route) {
    location.hash = route;
  }

  function updateNav() {
    const active = currentPage === "transaction-form" ? "transactions" : currentPage === "category-form" ? "categories" : currentPage === "budget-form" ? "budgets" : currentPage;
    document.querySelectorAll(".side-nav .nav-link").forEach((link) => {
      link.classList.toggle("active", link.dataset.page === active);
    });
    $("#currentPageName").textContent = PAGE_NAMES[currentPage] || "Dashboard";
    $("#todayLabel").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $("#sidebar").classList.remove("sidebar-open");
    $("#menuToggle").setAttribute("aria-expanded", "false");
  }

  function render() {
    const route = getPageRoute();
    currentPage = route.page;
    updateNav();
    document.body.dataset.theme = state.preferences.theme;
    content.replaceChildren();
    charts.forEach((chart) => chart.disconnect?.());
    charts = [];
    if (storageWarning) {
      content.append(h("div", { className: "alert-card", text: "SpendWise found damaged or unavailable saved data. Your saved copy was preserved where possible, and a fresh local workspace is being used." }));
    }
    if (currentPage === "dashboard") renderDashboard();
    else if (currentPage === "transactions") renderTransactions();
    else if (currentPage === "transaction-form") renderTransactionForm(route.id);
    else if (currentPage === "categories") renderCategories();
    else if (currentPage === "category-form") renderCategoryForm(route.id);
    else if (currentPage === "budgets") renderBudgets();
    else if (currentPage === "budget-form") renderBudgetForm(route.id);
    else if (currentPage === "reports") renderReports();
    else renderSettings();
  }

  function pageHeading(eyebrow, title, subtitle, action) {
    const copy = h("div", {}, [
      h("p", { className: "eyebrow", text: eyebrow }),
      h("h1", { text: title }),
      h("p", { className: "subheading", text: subtitle }),
    ]);
    const wrapper = h("div", { className: `page-heading${action ? " heading-row" : ""}` }, [copy]);
    if (action) wrapper.append(action);
    return wrapper;
  }

  function panelHeading(title, subtitle, linkLabel, linkTarget) {
    const heading = h("div", { className: "panel-heading" }, [
      h("div", {}, [h("h2", { text: title }), h("p", { text: subtitle })]),
    ]);
    if (linkLabel) heading.append(h("a", { className: "text-link", href: linkTarget, text: `${linkLabel} →` }));
    return heading;
  }

  function emptyState(icon, title, message, actionLabel, route) {
    const box = h("div", { className: "empty-state" }, [
      h("span", { className: "empty-illustration", text: icon }),
      h("strong", { text: title }),
      h("p", { text: message }),
    ]);
    if (actionLabel && route) box.append(h("a", { className: "text-link", href: route, text: `${actionLabel} →` }));
    return box;
  }

  function selectedRange(range) {
    const today = localDate(todayISO());
    if (range === "all") return { start: "0000-01-01", end: todayISO() };
    if (range === "week") {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      return { start: localISO(start), end: todayISO() };
    }
    if (range === "90") {
      const start = new Date(today);
      start.setDate(today.getDate() - 89);
      return { start: localISO(start), end: todayISO() };
    }
    if (range === "month") return monthBounds();
    const start = new Date(today);
    start.setDate(today.getDate() - 29);
    return { start: localISO(start), end: todayISO() };
  }

  function transactionsBetween(start, end) {
    return state.transactions.filter((item) => item.date >= start && item.date <= end);
  }

  function sum(items, predicate = () => true) {
    return items.reduce((total, item) => predicate(item) ? total + Number(item.amount) : total, 0);
  }

  function transactionAmountByType(items, type) {
    return sum(items, (item) => item.type === type);
  }

  function monthExpenses(month = monthKey()) {
    const bounds = monthBounds(month);
    return sum(transactionsBetween(bounds.start, bounds.end), (item) => item.type === "expense");
  }

  function currentOverallBudget(month = monthKey()) {
    return state.budgets.find((budget) => budget.type === "overall" && budget.month === month);
  }

  function makeCanvasChart(container, draw) {
    if (!container) return;
    const canvas = h("canvas", { role: "img", "aria-label": "Financial chart" });
    container.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) {
      container.replaceChildren(h("div", { className: "chart-empty", text: "Charts are unavailable in this browser." }));
      return;
    }
    const redraw = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(220, rect.width);
      const height = Math.max(165, parseFloat(getComputedStyle(canvas).height) || 210);
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      draw(context, width, height);
    };
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(container);
    charts.push(observer);
  }

  function chartColor(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function lineChart(container, datasets, labels) {
    if (!datasets.some((series) => series.values.some((value) => value > 0))) {
      container.replaceChildren(h("div", { className: "chart-empty", text: "Add transactions to see your spending trend." }));
      return;
    }
    makeCanvasChart(container, (ctx, width, height) => {
      const left = 38, right = 12, top = 14, bottom = 28;
      const chartW = width - left - right, chartH = height - top - bottom;
      const max = Math.max(1, ...datasets.flatMap((series) => series.values)) * 1.15;
      ctx.font = "10px DM Sans, sans-serif";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = chartColor("--line", "#e8edf1");
      ctx.fillStyle = chartColor("--muted", "#8793a4");
      for (let i = 0; i <= 3; i++) {
        const y = top + chartH * i / 3;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(formatMoney(max * (1 - i / 3), 0), left - 7, y);
      }
      labels.forEach((label, index) => {
        const x = left + (labels.length <= 1 ? chartW / 2 : chartW * index / (labels.length - 1));
        if (index % Math.ceil(labels.length / 6) === 0 || index === labels.length - 1) {
          ctx.textAlign = "center";
          ctx.fillText(label, x, height - 11);
        }
      });
      datasets.forEach((series) => {
        ctx.beginPath();
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 2.5;
        series.values.forEach((value, index) => {
          const x = left + (labels.length <= 1 ? chartW / 2 : chartW * index / (labels.length - 1));
          const y = top + chartH - (value / max) * chartH;
          if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        series.values.forEach((value, index) => {
          const x = left + (labels.length <= 1 ? chartW / 2 : chartW * index / (labels.length - 1));
          const y = top + chartH - (value / max) * chartH;
          ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = series.color; ctx.fill();
        });
      });
    });
  }

  function barChart(container, labels, first, second, firstLabel = "Income", secondLabel = "Expenses") {
    if (![...first, ...second].some((value) => value > 0)) {
      container.replaceChildren(h("div", { className: "chart-empty", text: "No income or expenses in this period yet." }));
      return;
    }
    makeCanvasChart(container, (ctx, width, height) => {
      const left = 38, right = 10, top = 12, bottom = 30;
      const chartH = height - top - bottom, chartW = width - left - right;
      const max = Math.max(1, ...first, ...second) * 1.15;
      ctx.font = "9px DM Sans, sans-serif";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = chartColor("--line", "#e8edf1");
      ctx.fillStyle = chartColor("--muted", "#8793a4");
      for (let i = 0; i <= 3; i++) {
        const y = top + chartH * i / 3;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(formatMoney(max * (1 - i / 3), 0), left - 7, y);
      }
      const step = chartW / Math.max(1, labels.length), barWidth = Math.min(15, step * .27);
      labels.forEach((label, index) => {
        const center = left + step * (index + .5);
        const h1 = first[index] / max * chartH, h2 = second[index] / max * chartH;
        ctx.fillStyle = "#10a878";
        ctx.fillRect(center - barWidth - 1, top + chartH - h1, barWidth, h1);
        ctx.fillStyle = "#ef927d";
        ctx.fillRect(center + 1, top + chartH - h2, barWidth, h2);
        ctx.fillStyle = chartColor("--muted", "#8793a4");
        ctx.textAlign = "center";
        ctx.fillText(label, center, height - 11);
      });
    });
    const legend = h("div", { className: "chart-legend" }, [
      legendItem("#10a878", firstLabel), legendItem("#ef927d", secondLabel),
    ]);
    container.parentElement.append(legend);
  }

  function legendItem(color, label) {
    return h("span", { className: "legend-item" }, [
      h("i", { className: "legend-dot", style: { "--legend-color": color } }),
      document.createTextNode(label),
    ]);
  }

  function donutChart(container, items) {
    const categories = state.categories.filter((category) => category.type === "expense");
    const values = categories.map((category) => ({
      category,
      value: sum(items, (transaction) => transaction.categoryId === category.id && transaction.type === "expense"),
    })).filter((item) => item.value > 0);
    if (!values.length) {
      container.replaceChildren(h("div", { className: "chart-empty", text: "No category spending in this period." }));
      return;
    }
    makeCanvasChart(container, (ctx, width, height) => {
      const total = values.reduce((acc, item) => acc + item.value, 0);
      const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * .32;
      let start = -Math.PI / 2;
      values.forEach(({ category, value }) => {
        const end = start + value / total * Math.PI * 2;
        ctx.beginPath(); ctx.arc(cx, cy, radius, start, end); ctx.arc(cx, cy, radius * .62, end, start, true); ctx.closePath();
        ctx.fillStyle = category.color; ctx.fill();
        start = end;
      });
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = chartColor("--ink", "#17243a");
      ctx.font = "700 14px Manrope, sans-serif";
      ctx.fillText(formatMoney(total, 0), cx, cy - 5);
      ctx.fillStyle = chartColor("--muted", "#8793a4");
      ctx.font = "9px DM Sans, sans-serif";
      ctx.fillText("total spend", cx, cy + 12);
    });
    const legend = h("div", { className: "chart-legend" }, values.map(({ category }) => legendItem(category.color, category.name)));
    container.parentElement.append(legend);
  }

  function makeChartPanel(title, subtitle, canvasClass = "") {
    const canvas = h("div", { className: `chart-canvas${canvasClass ? ` ${canvasClass}` : ""}` });
    const panel = h("article", { className: "panel chart-panel" }, [
      panelHeading(title, subtitle),
      canvas,
    ]);
    return { panel, canvas };
  }

  function renderDashboard() {
    const range = pageFilters.dashboardRange || "month";
    const bounds = selectedRange(range);
    const filtered = transactionsBetween(bounds.start, bounds.end);
    const income = transactionAmountByType(filtered, "income");
    const expenses = transactionAmountByType(filtered, "expense");
    const monthlyBudget = currentOverallBudget();
    const currentExpenses = monthExpenses();
    const remaining = monthlyBudget ? Number(monthlyBudget.amount) - currentExpenses : null;

    const add = button("+ Add transaction", "button-primary", { onclick: () => navigate("#transaction-form") });
    content.append(pageHeading("YOUR MONEY AT A GLANCE", "Your money at a glance", "Here’s how your finances are looking.", add));
    const rangeRow = h("div", { className: "dashboard-range" }, [
      h("label", { className: "field-label", htmlFor: "dashboardRange", text: "Dashboard date range" }),
      h("select", { id: "dashboardRange", className: "filter-control" }, [
        h("option", { value: "week", selected: range === "week", text: "Last 7 days" }),
        h("option", { value: "month", selected: range === "month", text: "This month" }),
        h("option", { value: "30", selected: range === "30", text: "Last 30 days" }),
        h("option", { value: "90", selected: range === "90", text: "Last 90 days" }),
        h("option", { value: "all", selected: range === "all", text: "All time" }),
      ]),
    ]);
    rangeRow.classList.add("dashboard-range");
    content.append(rangeRow);

    const stats = h("section", { className: "summary-grid" });
    stats.append(summaryCard("Income", formatMoney(income), "In selected range", "↙", "income"));
    stats.append(summaryCard("Expenses", formatMoney(expenses), "In selected range", "↗", "expense"));
    stats.append(summaryCard("Monthly budget left", remaining === null ? "Not set" : formatMoney(remaining), remaining === null ? "Set an overall budget to track it" : "Current month · overall", "▤", "balance"));
    content.append(stats);

    const breakdown = h("div", { className: "content-grid" });
    const spendPanel = h("article", { className: "panel" }, [panelHeading("Spending breakdown", "By category in selected range", "All categories", "#categories")]);
    const categoryList = h("div", { className: "category-spend-list" });
    const expensesByCategory = state.categories.filter((category) => category.type === "expense").map((category) => ({
      category,
      total: sum(filtered, (item) => item.type === "expense" && item.categoryId === category.id),
      count: filtered.filter((item) => item.type === "expense" && item.categoryId === category.id).length,
    })).filter((item) => item.total > 0).sort((a, b) => b.total - a.total).slice(0, 5);
    if (!expensesByCategory.length) categoryList.append(emptyState("◌", "Nothing to break down yet", "Add an expense to see your spending categories.", "Add transaction", "#transaction-form"));
    expensesByCategory.forEach(({ category, total, count }) => {
      const row = h("div", { className: "category-spend" }, [
        categoryIcon(category, "category-icon"),
        h("div", { className: "category-info" }, [
          h("div", { className: "category-title" }, [h("strong", { text: category.name }), h("span", { text: formatMoney(total) })]),
          h("div", { className: "progress-track" }, [h("div", { className: "progress-fill", style: { width: `${expenses ? total / expenses * 100 : 0}%`, "--category-color": category.color } })]),
          h("small", { text: `${count} transaction${count === 1 ? "" : "s"}` }),
        ]),
      ]);
      categoryList.append(row);
    });
    spendPanel.append(categoryList);
    const budgetPanel = h("article", { className: "panel" }, [panelHeading("Monthly budgets", "Your spending guardrails", "Manage", "#budgets")]);
    const activeBudgets = state.budgets.filter((budget) => budget.month === monthKey()).slice(0, 4);
    if (!activeBudgets.length) budgetPanel.append(emptyState("▤", "No budgets set up", "Set an overall or category budget to start tracking.", "Set a budget", "#budget-form"));
    activeBudgets.forEach((budget) => {
      const isOverall = budget.type === "overall";
      const category = isOverall ? null : categoryById(budget.categoryId);
      const spent = isOverall
        ? monthExpenses(budget.month)
        : sum(transactionsBetween(monthBounds(budget.month).start, monthBounds(budget.month).end), (item) => item.categoryId === budget.categoryId && item.type === "expense");
      budgetPanel.append(budgetProgressRow(isOverall ? "Overall monthly" : (category?.name || "Category"), spent, budget.amount, category?.color || "#10a878"));
    });
    breakdown.append(spendPanel, budgetPanel);
    content.append(breakdown);

    const trends = h("div", { className: "chart-grid" });
    const weekly = makeChartPanel("Weekly spending", "Daily expense trend · last 7 days");
    const weekDates = Array.from({ length: 7 }, (_, index) => {
      const date = localDate(todayISO());
      date.setDate(date.getDate() - 6 + index);
      return localISO(date);
    });
    lineChart(weekly.canvas, [{ color: "#10a878", values: weekDates.map((date) => sum(state.transactions, (item) => item.date === date && item.type === "expense")) }], weekDates.map((date) => dateLabel(date, { weekday: "short" })));
    const monthly = makeChartPanel("Monthly spending", "Income and expenses · last 6 months");
    const monthKeys = Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setDate(1);
      date.setMonth(date.getMonth() - 5 + index);
      return monthKey(date);
    });
    const monthValues = monthKeys.map((key) => {
      const dates = monthBounds(key);
      const monthTransactions = transactionsBetween(dates.start, dates.end);
      return [transactionAmountByType(monthTransactions, "income"), transactionAmountByType(monthTransactions, "expense")];
    });
    barChart(monthly.canvas, monthKeys.map((key) => new Date(`${key}-01T12:00:00`).toLocaleDateString(undefined, { month: "short" })), monthValues.map((value) => value[0]), monthValues.map((value) => value[1]));
    trends.append(weekly.panel, monthly.panel);
    content.append(trends);

    const recentPanel = h("article", { className: "panel recent-panel" }, [panelHeading("Recent transactions", "Your latest money moves", "See all", "#transactions")]);
    const recentItems = [...state.transactions].sort(sortByDateDescending).slice(0, 6);
    recentPanel.append(recentItems.length ? transactionTable(recentItems, { compact: true }) : emptyState("↔", "Your story starts here", "Once you add transactions, you'll see them here.", "Add transaction", "#transaction-form"));
    content.append(recentPanel);
    $("#dashboardRange").addEventListener("change", (event) => {
      pageFilters.dashboardRange = event.target.value;
      render();
    });
  }

  function summaryCard(label, value, note, icon, type) {
    const card = h("article", { className: `summary-card${type === "balance" ? " balance-card" : ""}` });
    card.append(
      h("div", { className: "card-top" }, [
        h("span", { className: "summary-label", text: label }),
        h("span", { className: type === "balance" ? "card-symbol" : `stat-icon ${type === "income" ? "income-icon" : "expense-icon"}`, text: icon }),
      ]),
      h("div", { className: "summary-value", text: value }),
      h("div", { className: "card-note" }, [
        type === "balance" ? h("span", { className: "trend-pill", text: "CURRENT MONTH" }) : null,
        document.createTextNode(note),
      ]),
    );
    if (type === "balance") card.append(h("div", { className: "balance-decoration" }));
    else {
      const chart = h("div", { className: `mini-line ${type === "expense" ? "coral-line" : "green-line"}` });
      for (let index = 0; index < 7; index++) chart.append(h("i"));
      card.append(chart);
    }
    return card;
  }

  function categoryIcon(category, className = "category-icon") {
    return h("span", { className, text: category?.icon || "◈", style: { "--category-color": category?.color || "#64748b" }, "aria-hidden": "true" });
  }

  function budgetProgressRow(label, spent, budget, color) {
    const percent = budget > 0 ? spent / budget * 100 : 0;
    const remaining = Number(budget) - spent;
    const fillClass = percent > 100 ? "over-budget" : percent >= Number(state.preferences.warningThreshold) ? "near-budget" : "";
    const row = h("div", { className: "budget-row" }, [
      h("div", { className: "budget-heading" }, [
        h("span", {}, [h("i", { className: "budget-dot", style: { "--category-color": color } }), document.createTextNode(label)]),
        h("strong", {}, [document.createTextNode(formatMoney(spent, 0)), h("small", { text: ` / ${formatMoney(budget, 0)}` })]),
      ]),
      h("div", { className: "progress-track" }, [h("div", { className: `progress-fill ${fillClass}`, style: { width: `${Math.min(percent, 100)}%` } })]),
      h("small", { className: "budget-foot", text: percent > 100 ? `Exceeded by ${formatMoney(Math.abs(remaining))}` : percent >= Number(state.preferences.warningThreshold) ? `Warning · ${Math.round(percent)}% of budget used` : `${formatMoney(remaining)} remaining` }),
    ]);
    return row;
  }

  function sortByDateDescending(a, b) {
    return b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  }

  function transactionTable(items, options = {}) {
    const table = h("table", { className: "data-table" });
    const head = h("thead");
    const header = h("tr");
    ["TRANSACTION", "CATEGORY", "DATE", "PAYMENT", "AMOUNT"].forEach((label, index) => header.append(h("th", { className: index === 4 ? "right" : "", text: label })));
    if (!options.compact) header.append(h("th", { className: "right", text: "ACTIONS" }));
    head.append(header);
    const body = h("tbody");
    items.forEach((item) => {
      const category = categoryById(item.categoryId);
      const tr = h("tr");
      const titleCell = h("td");
      const titleRow = h("div", { className: "transaction-cell" }, [
        categoryIcon(category, "category-icon small-category"),
        h("div", {}, [
          h("strong", { text: item.title }),
          item.notes ? h("small", { text: item.notes, style: { display: "block", maxWidth: "180px", marginTop: "3px", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" } }) : null,
        ]),
      ]);
      titleCell.append(titleRow);
      const categoryCell = h("td");
      const categoryLabel = h("span", { className: "category-pill", text: `${category?.name || "Removed category"}${category?.archived ? " · archived" : ""}` });
      categoryCell.append(categoryLabel);
      const amountCell = h("td", { className: `right amount-cell${item.type === "income" ? " amount-positive" : ""}`, text: `${item.type === "income" ? "+" : "−"}${formatMoney(item.amount)}` });
      tr.append(titleCell, categoryCell, h("td", { text: dateLabel(item.date) }), h("td", { text: item.paymentMethod }), amountCell);
      if (!options.compact) {
        const actionCell = h("td", { className: "right" });
        const actions = h("div", { className: "action-cell" }, [
          button("Edit", "button-small", { "data-action": "edit-transaction", "data-id": item.id, "aria-label": `Edit ${item.title}` }),
          button("Delete", "button-small button-danger", { "data-action": "delete-transaction", "data-id": item.id, "aria-label": `Delete ${item.title}` }),
        ]);
        actionCell.append(actions);
        tr.append(actionCell);
      }
      body.append(tr);
    });
    table.append(head, body);
    const wrap = h("div", { className: "table-wrap" }, [table]);
    return wrap;
  }

  function filteredTransactions(filters = {}) {
    let rows = [...state.transactions];
    if (filters.query) rows = rows.filter((item) => item.title.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase()));
    if (filters.type && filters.type !== "all") rows = rows.filter((item) => item.type === filters.type);
    if (filters.categoryId && filters.categoryId !== "all") rows = rows.filter((item) => item.categoryId === filters.categoryId);
    if (filters.payment && filters.payment !== "all") rows = rows.filter((item) => item.paymentMethod === filters.payment);
    if (filters.from) rows = rows.filter((item) => item.date >= filters.from);
    if (filters.to) rows = rows.filter((item) => item.date <= filters.to);
    if (filters.sort === "amount-asc") rows.sort((a, b) => a.amount - b.amount);
    else if (filters.sort === "amount-desc") rows.sort((a, b) => b.amount - a.amount);
    else if (filters.sort === "date-asc") rows.sort((a, b) => a.date.localeCompare(b.date));
    else rows.sort(sortByDateDescending);
    return rows;
  }

  function renderTransactions() {
    const filters = pageFilters.transactions || (pageFilters.transactions = { query: "", type: "all", categoryId: "all", payment: "all", from: "", to: "", sort: "date-desc", page: 1 });
    const add = button("+ Add transaction", "button-primary", { onclick: () => navigate("#transaction-form") });
    content.append(pageHeading("YOUR MONEY, IN MOTION", "Transactions", "A clear view of every dollar in and out.", add));
    const toolbar = h("div", { className: "section-toolbar" });
    const group = h("div", { className: "toolbar-group" });
    const search = h("input", { className: "search-control", type: "search", placeholder: "Search transactions...", "aria-label": "Search by transaction title", value: filters.query });
    search.addEventListener("input", () => { filters.query = search.value; filters.page = 1; refreshTransactionRows(); });
    const type = makeSelect("typeFilter", [["all", "All types"], ["expense", "Expenses"], ["income", "Income"]], filters.type, "filter-control");
    type.addEventListener("change", () => { filters.type = type.value; filters.page = 1; refreshTransactionRows(); });
    const category = makeSelect("categoryFilter", [["all", "All categories"], ...state.categories.map((item) => [item.id, `${item.icon} ${item.name}${item.archived ? " · archived" : ""}`])], filters.categoryId, "filter-control");
    category.addEventListener("change", () => { filters.categoryId = category.value; filters.page = 1; refreshTransactionRows(); });
    const payment = makeSelect("paymentFilter", [["all", "All methods"], ...[...new Set(state.transactions.map((item) => item.paymentMethod).filter(Boolean))].sort().map((item) => [item, item])], filters.payment, "filter-control");
    payment.addEventListener("change", () => { filters.payment = payment.value; filters.page = 1; refreshTransactionRows(); });
    group.append(search, type, category, payment);
    const sort = makeSelect("sortFilter", [["date-desc", "Newest first"], ["date-asc", "Oldest first"], ["amount-desc", "Highest amount"], ["amount-asc", "Lowest amount"]], filters.sort, "filter-control");
    sort.addEventListener("change", () => { filters.sort = sort.value; refreshTransactionRows(); });
    toolbar.append(group, sort);
    content.append(toolbar);
    const dateToolbar = h("div", { className: "toolbar-group", style: { margin: "-6px 0 14px" } });
    const from = h("input", { className: "filter-control", type: "date", value: filters.from, "aria-label": "From date" });
    const to = h("input", { className: "filter-control", type: "date", value: filters.to, "aria-label": "To date" });
    from.addEventListener("change", () => { filters.from = from.value; filters.page = 1; refreshTransactionRows(); });
    to.addEventListener("change", () => { filters.to = to.value; filters.page = 1; refreshTransactionRows(); });
    const clear = button("Clear filters", "button-light", { onclick: () => { Object.assign(filters, { query: "", type: "all", categoryId: "all", payment: "all", from: "", to: "", sort: "date-desc", page: 1 }); render(); } });
    dateToolbar.append(h("span", { className: "count-note", text: "Date range" }), from, h("span", { className: "count-note", text: "to" }), to, clear);
    content.append(dateToolbar);
    const panel = h("section", { className: "panel recent-panel" }, [panelHeading("All transactions", "Search, filter, edit, or remove records.")]);
    const rows = h("div", { id: "transactionRows" });
    panel.append(rows);
    content.append(panel);
    refreshTransactionRows();

    function refreshTransactionRows() {
      if (!$("#transactionRows")) return;
      const all = filteredTransactions(filters);
      const pageSize = 10;
      const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
      filters.page = Math.min(filters.page, pageCount);
      const visible = all.slice((filters.page - 1) * pageSize, filters.page * pageSize);
      const slot = $("#transactionRows");
      slot.replaceChildren();
      if (!all.length) slot.append(emptyState("↔", "No matching transactions", "Try changing the filters or add a new transaction.", "Add transaction", "#transaction-form"));
      else {
        slot.append(transactionTable(visible), h("div", { className: "section-toolbar", style: { margin: "12px 0 0" } }, [
          h("span", { className: "count-note", text: `Showing ${(filters.page - 1) * pageSize + 1}–${Math.min(filters.page * pageSize, all.length)} of ${all.length}` }),
          h("div", { className: "toolbar-group" }, [
            button("Previous", "button-light", { disabled: filters.page <= 1, onclick: () => { filters.page--; refreshTransactionRows(); } }),
            h("span", { className: "count-note", text: `Page ${filters.page} of ${pageCount}` }),
            button("Next", "button-light", { disabled: filters.page >= pageCount, onclick: () => { filters.page++; refreshTransactionRows(); } }),
          ]),
        ]));
      }
    }
  }

  function makeSelect(id, options, selected, className = "field") {
    const select = h("select", { id, className });
    options.forEach(([value, label]) => select.append(h("option", { value, selected: value === selected, text: label })));
    return select;
  }

  function renderTransactionForm(id) {
    const existing = id ? state.transactions.find((item) => item.id === id) : null;
    if (id && !existing) {
      navigate("#transactions");
      showToast("That transaction could not be found.", true);
      return;
    }
    const categories = state.categories.filter((category) => !category.archived || category.id === existing?.categoryId);
    const heading = pageHeading("KEEP YOUR TRACKER UP TO DATE", existing ? "Edit transaction" : "Add transaction", "Record an income or expense in just a few details.");
    content.append(heading);
    const form = h("form", { className: "panel form-panel", novalidate: true });
    const errors = h("div", { className: "form-errors", role: "alert" });
    const grid = h("div", { className: "form-grid" });
    const title = field("Title", "title", "text", existing?.title || "", { required: true, maxlength: 90, placeholder: "e.g. Coffee with friends" });
    const amount = field("Amount", "amount", "number", existing?.amount || "", { required: true, min: "0.01", step: "0.01", placeholder: "0.00" });
    const type = makeSelect("transactionType", [["expense", "Expense"], ["income", "Income"]], existing?.type || "expense");
    const categorySelect = h("select", { id: "transactionCategory", className: "field", required: true });
    const date = field("Date", "date", "date", existing?.date || todayISO(), { required: true, max: "9999-12-31" });
    const payment = makeSelect("paymentMethod", [["Cash", "Cash"], ["Card", "Card"], ["Bank transfer", "Bank transfer"], ["Digital wallet", "Digital wallet"], ["Other", "Other"]], existing?.paymentMethod || "Card");
    const notes = field("Notes (optional)", "notes", "textarea", existing?.notes || "", { maxlength: 500, placeholder: "Add a note..." });
    const titleWrap = fieldWrap("Title", title, true);
    const amountWrap = fieldWrap("Amount", amount);
    const typeWrap = fieldWrap("Type", type);
    const categoryWrap = fieldWrap("Category", categorySelect);
    const dateWrap = fieldWrap("Date", date);
    const paymentWrap = fieldWrap("Payment method", payment);
    const notesWrap = fieldWrap("Notes (optional)", notes, false, "field-wide");
    grid.append(titleWrap, amountWrap, typeWrap, categoryWrap, dateWrap, paymentWrap, notesWrap);
    const actions = h("div", { className: "form-actions" }, [
      button("Cancel", "button-light", { onclick: () => navigate("#transactions") }),
      h("button", { className: "button-primary", type: "submit", text: existing ? "Save changes" : "Save transaction" }),
    ]);
    form.append(errors, grid, actions);
    content.append(form);

    function refreshCategoryChoices() {
      const selectedType = type.value;
      categorySelect.replaceChildren(h("option", { value: "", text: "Choose a category" }));
      categories.filter((categoryItem) => categoryItem.type === selectedType).forEach((categoryItem) => {
        categorySelect.append(h("option", { value: categoryItem.id, selected: categoryItem.id === (existing?.categoryId || categorySelect.dataset.value), text: `${categoryItem.icon} ${categoryItem.name}` }));
      });
    }
    categorySelect.dataset.value = existing?.categoryId || "";
    refreshCategoryChoices();
    type.addEventListener("change", refreshCategoryChoices);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errors.replaceChildren();
      const parsed = Number(amount.value);
      const categoryItem = categoryById(categorySelect.value);
      const validation = [];
      if (!title.value.trim()) validation.push("Enter a transaction title.");
      if (!Number.isFinite(parsed) || parsed <= 0) validation.push("Enter an amount greater than zero.");
      if (!categoryItem || categoryItem.archived || categoryItem.type !== type.value) validation.push("Choose an active category that matches the transaction type.");
      if (!isValidDate(date.value)) validation.push("Choose a valid transaction date.");
      if (validation.length) {
        validation.forEach((message) => errors.append(h("p", { className: "field-error", text: message })));
        errors.focus?.();
        return;
      }
      const record = {
        id: existing?.id || uid(),
        title: title.value.trim(),
        amount: Math.round(parsed * 100) / 100,
        type: type.value,
        categoryId: categoryItem.id,
        date: date.value,
        paymentMethod: payment.value,
        notes: notes.value.trim(),
      };
      if (existing) state.transactions = state.transactions.map((item) => item.id === existing.id ? record : item);
      else state.transactions.push(record);
      if (save()) {
        showToast(existing ? "Transaction updated." : "Transaction saved.");
        pageFilters.transactions = null;
        navigate("#transactions");
      }
    });
  }

  function field(label, id, type, value = "", attrs = {}) {
    if (type === "textarea") return h("textarea", { className: "field", id, name: id, ...attrs, text: value });
    return h("input", { className: "field", id, name: id, type, value, ...attrs });
  }

  function fieldWrap(label, control, required = false, extraClass = "") {
    const id = control.id;
    return h("div", { className: `form-field${extraClass ? ` ${extraClass}` : ""}` }, [
      h("label", { className: "field-label", htmlFor: id }, [
        document.createTextNode(label),
        required ? h("span", { className: "field-required", text: " *" }) : null,
      ]),
      control,
    ]);
  }

  function renderCategories() {
    const filters = pageFilters.categories || (pageFilters.categories = { query: "", type: "all", status: "active" });
    content.append(pageHeading("MAKE IT YOURS", "Manage categories", "Organize your money with categories that fit your life.", button("+ New category", "button-primary", { onclick: () => navigate("#category-form") })));
    const toolbar = h("div", { className: "section-toolbar" });
    const search = h("input", { type: "search", className: "search-control", placeholder: "Search categories...", value: filters.query, "aria-label": "Search categories" });
    search.addEventListener("input", () => { filters.query = search.value; updateCards(); });
    const typeTabs = h("div", { className: "filter-tabs" });
    [["all", "All types"], ["expense", "Expenses"], ["income", "Income"]].forEach(([value, label]) => {
      const tab = button(label, filters.type === value ? "selected" : "", { onclick: () => { filters.type = value; render(); } });
      typeTabs.append(tab);
    });
    const status = makeSelect("categoryStatus", [["active", "Active categories"], ["archived", "Archived categories"]], filters.status, "filter-control");
    status.addEventListener("change", () => { filters.status = status.value; updateCards(); });
    toolbar.append(h("div", { className: "toolbar-group" }, [search, typeTabs]), status);
    const grid = h("div", { className: "category-card-grid", id: "categoryCardGrid" });
    content.append(toolbar, grid);
    content.append(h("p", { className: "category-tip", text: "✦ Categories with history can be safely reassigned or archived; transactions are never silently removed." }));

    function updateCards() {
      const filtered = state.categories.filter((category) => {
        const matchType = filters.type === "all" || category.type === filters.type;
        const matchStatus = filters.status === "archived" ? category.archived : !category.archived;
        const matchQuery = !filters.query || category.name.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase());
        return matchType && matchStatus && matchQuery;
      });
      grid.replaceChildren();
      if (!filtered.length) {
        grid.append(emptyState("◈", "No categories found", "Try another search or add a category.", "Create category", "#category-form"));
        return;
      }
      filtered.forEach((category) => {
        const rows = state.transactions.filter((item) => item.categoryId === category.id);
        const total = sum(rows, (item) => item.type === category.type);
        const card = h("article", { className: `managed-category${category.archived ? " archived-card" : ""}` });
        card.append(
          h("div", { className: "managed-category-top" }, [categoryIcon(category, "category-icon category-icon-large"), h("span", { className: `type-badge ${category.type}`, text: category.type === "income" ? "INCOME" : "EXPENSE" })]),
          h("h3", { text: category.name }),
          h("p", { className: "category-description", text: category.description || "No description added" }),
          h("div", { className: "category-metrics" }, [
            h("span", {}, [h("strong", { text: String(rows.length) }), document.createTextNode(` transaction${rows.length === 1 ? "" : "s"}`)]),
            h("strong", { text: formatMoney(total) }),
          ]),
        );
        if (category.archived) card.append(h("span", { className: "archived-label", text: "Archived · history retained" }));
        const actions = h("div", { className: "category-actions" }, [
          button("Edit", "button-small", { "data-action": "edit-category", "data-id": category.id }),
          category.archived
            ? button("Restore", "button-small", { "data-action": "restore-category", "data-id": category.id })
            : button("Delete", "button-small button-danger", { "data-action": "delete-category", "data-id": category.id }),
        ]);
        card.append(actions);
        grid.append(card);
      });
    }
    updateCards();
  }

  function renderCategoryForm(id) {
    const existing = id ? categoryById(id) : null;
    if (id && !existing) {
      navigate("#categories");
      showToast("That category could not be found.", true);
      return;
    }
    content.append(pageHeading("MAKE IT YOURS", existing ? "Edit category" : "Create category", "Set up a category that fits how you manage money."));
    const form = h("form", { className: "panel form-panel" });
    const errors = h("div", { role: "alert" });
    const grid = h("div", { className: "form-grid" });
    const name = field("Category name", "categoryName", "text", existing?.name || "", { required: true, maxlength: 50, placeholder: "e.g. Gym Membership" });
    const type = makeSelect("categoryType", [["expense", "Expense"], ["income", "Income"]], existing?.type || "expense");
    const icon = field("Icon or emoji", "categoryIcon", "text", existing?.icon || "✦", { required: true, maxlength: 12, placeholder: "e.g. 🏋️" });
    const color = field("Category color", "categoryColor", "color", existing?.color || "#10a878");
    const description = field("Description (optional)", "categoryDescription", "textarea", existing?.description || "", { maxlength: 180, placeholder: "What do you use this category for?" });
    grid.append(fieldWrap("Category name", name, true), fieldWrap("Type", type, true), fieldWrap("Icon or emoji", icon, true), fieldWrap("Category color", color, true), fieldWrap("Description (optional)", description, false, "field-wide"));
    const actions = h("div", { className: "form-actions" }, [
      button("Cancel", "button-light", { onclick: () => navigate("#categories") }),
      h("button", { className: "button-primary", type: "submit", text: existing ? "Save changes" : "Create category" }),
    ]);
    form.append(errors, grid, actions);
    content.append(form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errors.replaceChildren();
      const categoryType = type.value;
      const trimmedName = name.value.trim();
      const duplicate = state.categories.some((category) => category.id !== existing?.id && category.type === categoryType && category.name.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase());
      const hasHistory = existing && state.transactions.some((item) => item.categoryId === existing.id);
      const hasBudget = existing && state.budgets.some((budget) => budget.categoryId === existing.id);
      const messages = [];
      if (!trimmedName) messages.push("Enter a category name.");
      if (duplicate) messages.push("A category with this name and type already exists.");
      if (!icon.value.trim()) messages.push("Add an icon or emoji.");
      if (hasHistory && existing.type !== categoryType) messages.push("Reassign this category's transactions before changing its type.");
      if (hasBudget && categoryType !== "expense") messages.push("Remove or reassign this category's budgets before changing it to income.");
      if (messages.length) {
        messages.forEach((message) => errors.append(h("p", { className: "field-error", text: message })));
        return;
      }
      const record = {
        id: existing?.id || uid(),
        name: trimmedName,
        type: categoryType,
        icon: icon.value.trim(),
        color: color.value,
        description: description.value.trim(),
        archived: existing?.archived || false,
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      if (existing) state.categories = state.categories.map((item) => item.id === existing.id ? record : item);
      else state.categories.push(record);
      if (save()) {
        showToast(existing ? "Category updated." : "Category created.");
        pageFilters.categories = null;
        navigate("#categories");
      }
    });
  }

  function showDialog(title, copy, body, actions) {
    focusBeforeDialog = document.activeElement;
    dialog.replaceChildren();
    const header = h("div", { className: "dialog-header" }, [
      h("h2", { id: "dialogTitle", text: title }),
      button("×", "dialog-close", { "aria-label": "Close dialog", onclick: closeDialog }),
    ]);
    dialog.append(header, h("p", { className: "dialog-copy", text: copy }));
    if (body) dialog.append(body);
    if (actions) dialog.append(h("div", { className: "dialog-actions" }, actions));
    backdrop.hidden = false;
    document.body.classList.add("dialog-open");
    dialog.focus();
  }

  function closeDialog() {
    backdrop.hidden = true;
    document.body.classList.remove("dialog-open");
    dialog.replaceChildren();
    focusBeforeDialog?.focus?.();
  }

  function showCategoryDelete(category) {
    const transactions = state.transactions.filter((item) => item.categoryId === category.id);
    const budgets = state.budgets.filter((budget) => budget.categoryId === category.id);
    if (!transactions.length && !budgets.length) {
      showDialog(`Delete ${category.name}?`, "This category has no transactions or budgets. You can delete it permanently.", null, [
        button("Cancel", "button-light", { onclick: closeDialog }),
        button("Delete category", "button-danger", { onclick: () => { state.categories = state.categories.filter((item) => item.id !== category.id); save(); closeDialog(); render(); showToast("Category deleted."); } }),
      ]);
      return;
    }

    const copy = `This category is used by ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}${budgets.length ? ` and ${budgets.length} budget${budgets.length === 1 ? "" : "s"}` : ""}. Historical transactions will not be deleted. Reassign history to a compatible category, or archive this category. If both categories have budgets for the same month, their limits will be combined.`;
    const select = makeSelect("reassignCategory", [["", "Choose compatible category"], ...state.categories.filter((item) => item.id !== category.id && item.type === category.type && !item.archived).map((item) => [item.id, `${item.icon} ${item.name}`])], "", "field");
    const body = h("div", {}, [
      transactions.length || budgets.length ? fieldWrap("Reassign history and budgets", select, true) : null,
      h("p", { className: "field-hint", text: "Archiving keeps all history and removes the category from new transaction choices. It can be restored later." }),
    ]);
    const reassignButton = button("Reassign & delete", "button-danger", { onclick: () => {
      const target = categoryById(select.value);
      if (!target || target.archived || target.type !== category.type) {
        select.setAttribute("aria-invalid", "true");
        select.focus();
        showToast("Choose an active category of the same type to reassign history.", true);
        return;
      }
      state.transactions = state.transactions.map((item) => item.categoryId === category.id ? { ...item, categoryId: target.id } : item);
      const sourceBudgets = state.budgets.filter((budget) => budget.categoryId === category.id);
      sourceBudgets.forEach((source) => {
        const matchingBudget = state.budgets.find((budget) => budget.id !== source.id && budget.categoryId === target.id && budget.month === source.month);
        if (matchingBudget) matchingBudget.amount = Math.round((Number(matchingBudget.amount) + Number(source.amount)) * 100) / 100;
        state.budgets = state.budgets.filter((budget) => budget.id !== source.id);
        if (!matchingBudget) state.budgets.push({ ...source, categoryId: target.id });
      });
      state.categories = state.categories.filter((item) => item.id !== category.id);
      save();
      closeDialog();
      render();
      showToast(`History reassigned to ${target.name}; category deleted.`);
    } });
    showDialog(`Delete ${category.name}?`, copy, body, [
      button("Cancel", "button-light", { onclick: closeDialog }),
      button("Archive category", "button-secondary", { onclick: () => { category.archived = true; save(); closeDialog(); render(); showToast("Category archived. History remains intact."); } }),
      reassignButton,
    ]);
  }

  function renderBudgets() {
    const month = pageFilters.budgetMonth || monthKey();
    const add = button("+ Set a budget", "button-primary", { onclick: () => navigate("#budget-form") });
    content.append(pageHeading("SPEND WITH INTENTION", "Your budgets", "Set helpful spending limits for the month.", add));
    const monthControl = h("div", { className: "section-toolbar" }, [
      h("div", { className: "toolbar-group" }, [
        h("label", { className: "field-label", htmlFor: "budgetMonth", text: "Budget month" }),
        h("input", { id: "budgetMonth", className: "filter-control", type: "month", value: month }),
      ]),
    ]);
    monthControl.querySelector("input").addEventListener("change", (event) => { if (isValidMonth(event.target.value)) { pageFilters.budgetMonth = event.target.value; render(); } });
    content.append(monthControl);

    const overall = currentOverallBudget(month);
    const expenses = monthExpenses(month);
    const overallPanel = h("section", { className: "panel", style: { marginBottom: "14px" } }, [panelHeading("Overall monthly budget", "Compared with all expense transactions · category budgets are not double-counted.")]);
    if (overall) {
      overallPanel.append(budgetProgressRow("All expenses", expenses, overall.amount, "#10a878"));
      overallPanel.append(h("div", { className: "category-actions" }, [
        button("Edit overall budget", "button-small", { "data-action": "edit-budget", "data-id": overall.id }),
        button("Delete", "button-small button-danger", { "data-action": "delete-budget", "data-id": overall.id }),
      ]));
    } else {
      overallPanel.append(emptyState("▤", "No overall budget for this month", "An overall limit helps you see total monthly spending.", "Set overall budget", "#budget-form/overall"));
    }
    content.append(overallPanel);

    const categoryBudgets = state.budgets.filter((budget) => budget.type === "category" && budget.month === month);
    const categoryPanel = h("section", { className: "panel" }, [panelHeading("Category budgets", "Progress uses actual expense transactions for each category.")]);
    const grid = h("div", { className: "budget-card-grid" });
    if (!categoryBudgets.length) grid.append(emptyState("◈", "No category budgets yet", "Add a category budget to keep a particular expense in view.", "Set a budget", "#budget-form"));
    categoryBudgets.forEach((budget) => {
      const category = categoryById(budget.categoryId);
      const bounds = monthBounds(budget.month);
      const spent = sum(transactionsBetween(bounds.start, bounds.end), (item) => item.type === "expense" && item.categoryId === budget.categoryId);
      const percent = spent / budget.amount * 100;
      const card = h("article", { className: "panel budget-card" }, [
        h("div", { className: "managed-category-top" }, [categoryIcon(category, "category-icon category-icon-large"), h("span", { className: "type-badge expense", text: new Date(`${budget.month}-01T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" }) })]),
        h("h3", { text: category?.name || "Unknown category" }),
        h("div", { className: "budget-total" }, [document.createTextNode(`${formatMoney(spent)} `), h("span", { text: `of ${formatMoney(budget.amount)}` })]),
        h("div", { className: "progress-track" }, [h("div", { className: `progress-fill${percent > 100 ? " over-budget" : percent >= Number(state.preferences.warningThreshold) ? " near-budget" : ""}`, style: { width: `${Math.min(percent, 100)}%` } })]),
        h("p", { className: "budget-foot", text: budgetMessage(spent, budget.amount) }),
        h("div", { className: "category-actions" }, [
          button("Edit", "button-small", { "data-action": "edit-budget", "data-id": budget.id }),
          button("Delete", "button-small button-danger", { "data-action": "delete-budget", "data-id": budget.id }),
        ]),
      ]);
      grid.append(card);
    });
    categoryPanel.append(grid);
    content.append(categoryPanel);
  }

  function budgetMessage(spent, limit) {
    const percentage = spent / limit * 100;
    if (percentage > 100) return `Exceeded by ${formatMoney(spent - limit)}.`;
    if (percentage >= Number(state.preferences.warningThreshold)) return `Warning: ${Math.round(percentage)}% used · ${formatMoney(limit - spent)} remaining.`;
    return `${formatMoney(limit - spent)} remaining.`;
  }

  function renderBudgetForm(id) {
    const existing = id ? state.budgets.find((item) => item.id === id) : null;
    if (id && !existing) {
      navigate("#budgets");
      showToast("That budget could not be found.", true);
      return;
    }
    const overallOnly = id === "overall" || location.hash.endsWith("/overall") || existing?.type === "overall";
    content.append(pageHeading("SPEND WITH INTENTION", existing ? "Edit budget" : "Set a budget", "Choose a spending limit and the month to track."));
    const form = h("form", { className: "panel form-panel" });
    const errors = h("div", { role: "alert" });
    const grid = h("div", { className: "form-grid" });
    let category = null;
    if (!overallOnly) {
      category = makeSelect("budgetCategory", [["", "Choose expense category"], ...state.categories.filter((item) => item.type === "expense" && (!item.archived || item.id === existing?.categoryId)).map((item) => [item.id, `${item.icon} ${item.name}${item.archived ? " · archived" : ""}`])], existing?.categoryId || "", "field");
      grid.append(fieldWrap("Category", category, true));
    }
    const month = field("Month", "budgetMonthForm", "month", existing?.month || pageFilters.budgetMonth || monthKey(), { required: true });
    const amount = field("Monthly limit", "budgetAmount", "number", existing?.amount || "", { required: true, min: "0.01", step: "0.01", placeholder: "0.00" });
    grid.append(fieldWrap("Month", month, true), fieldWrap("Monthly limit", amount, true));
    const actions = h("div", { className: "form-actions" }, [
      button("Cancel", "button-light", { onclick: () => navigate("#budgets") }),
      h("button", { className: "button-primary", type: "submit", text: existing ? "Save changes" : "Save budget" }),
    ]);
    form.append(errors, grid, actions);
    content.append(form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errors.replaceChildren();
      const value = Number(amount.value);
      const budgetMonth = month.value;
      const messages = [];
      if (!Number.isFinite(value) || value <= 0) messages.push("Enter an amount greater than zero.");
      if (!isValidMonth(budgetMonth)) messages.push("Choose a valid month.");
      if (!overallOnly && !categoryById(category.value)) messages.push("Choose an expense category.");
      const categoryId = overallOnly ? null : category.value;
      const duplicate = state.budgets.some((budget) => budget.id !== existing?.id && budget.month === budgetMonth && budget.categoryId === categoryId);
      if (duplicate) messages.push("A budget already exists for that category and month. Edit it instead.");
      if (messages.length) {
        messages.forEach((message) => errors.append(h("p", { className: "field-error", text: message })));
        return;
      }
      const record = { id: existing?.id || uid(), type: overallOnly ? "overall" : "category", categoryId, month: budgetMonth, amount: Math.round(value * 100) / 100 };
      if (existing) state.budgets = state.budgets.map((budget) => budget.id === existing.id ? record : budget);
      else state.budgets.push(record);
      if (save()) {
        pageFilters.budgetMonth = budgetMonth;
        showToast(existing ? "Budget updated." : "Budget saved.");
        navigate("#budgets");
      }
    });
  }

  function renderReports() {
    const filters = pageFilters.reports || (pageFilters.reports = { from: selectedRange("month").start, to: todayISO(), type: "expense" });
    content.append(pageHeading("MAKE SENSE OF THE NUMBERS", "Reports", "Explore patterns and export a copy of your filtered activity."));
    const toolbar = h("div", { className: "section-toolbar" });
    const controls = h("div", { className: "toolbar-group" });
    const from = h("input", { type: "date", className: "filter-control", value: filters.from, "aria-label": "Report start date" });
    const to = h("input", { type: "date", className: "filter-control", value: filters.to, "aria-label": "Report end date" });
    const type = makeSelect("reportType", [["expense", "Expenses"], ["income", "Income"], ["all", "All transactions"]], filters.type, "filter-control");
    const exportButton = button("Export filtered CSV", "button-secondary", { onclick: () => exportCsv(filteredReportRows()) });
    [from, to, type].forEach((control) => control.addEventListener("change", () => {
      filters.from = from.value; filters.to = to.value; filters.type = type.value;
      if (filters.from && filters.to && filters.from > filters.to) {
        showToast("Start date must be before end date.", true);
        return;
      }
      render();
    }));
    controls.append(h("span", { className: "count-note", text: "From" }), from, h("span", { className: "count-note", text: "to" }), to, type);
    toolbar.append(controls, exportButton);
    content.append(toolbar);
    if (filters.from && filters.to && filters.from > filters.to) {
      content.append(h("div", { className: "alert-card danger", text: "Choose a start date before the end date." }));
      return;
    }
    const rows = filteredReportRows();
    const income = transactionAmountByType(rows, "income");
    const expense = transactionAmountByType(rows, "expense");
    const summary = h("div", { className: "report-summary" }, [
      reportStat("Total income", formatMoney(income)),
      reportStat("Total expenses", formatMoney(expense)),
      reportStat("Transactions", String(rows.length)),
    ]);
    content.append(summary);

    const chartsRow = h("div", { className: "chart-grid" });
    const weekly = makeChartPanel("Weekly expense summary", "Expenses grouped by week · selected range", "chart-small");
    const weeks = weeklyBuckets(filters.from, filters.to);
    lineChart(weekly.canvas, [{ color: "#10a878", values: weeks.map((week) => sum(rows, (item) => item.type === "expense" && week.start <= item.date && item.date <= week.end)) }], weeks.map((week) => dateLabel(week.start, { month: "short", day: "numeric" })));
    const categories = makeChartPanel("Category breakdown", "Expense total by category", "chart-small");
    donutChart(categories.canvas, rows);
    const months = monthsBetween(filters.from, filters.to);
    const monthTotals = months.map((month) => {
      const monthRows = rows.filter((item) => item.date.startsWith(month));
      return transactionAmountByType(monthRows, "expense");
    });
    const monthlySummary = makeChartPanel("Monthly expense summary", "Expenses grouped by month · selected range", "chart-small");
    lineChart(monthlySummary.canvas, [{ color: "#ef927d", values: monthTotals }], months.map((month) => new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "2-digit" })));
    const comparison = makeChartPanel("Income vs expense", "Monthly comparison · selected range", "chart-small");
    const monthlyValues = months.map((month) => {
      const monthRows = rows.filter((item) => item.date.startsWith(month));
      return [transactionAmountByType(monthRows, "income"), transactionAmountByType(monthRows, "expense")];
    });
    barChart(comparison.canvas, months.map((month) => new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "2-digit" })), monthlyValues.map((item) => item[0]), monthlyValues.map((item) => item[1]));
    chartsRow.append(weekly.panel, categories.panel, monthlySummary.panel, comparison.panel);
    content.append(chartsRow);

    const groupRows = state.categories.filter((category) => category.type === "expense").map((category) => {
      const matches = rows.filter((item) => item.type === "expense" && item.categoryId === category.id);
      return { category, count: matches.length, total: sum(matches) };
    }).filter((item) => item.count > 0).sort((a, b) => b.total - a.total);
    const breakdown = h("section", { className: "panel recent-panel" }, [panelHeading("Category-wise expense summary", "Totals for the selected date range.")]);
    if (groupRows.length) {
      const table = h("table", { className: "data-table" }, [
        h("thead", {}, [h("tr", {}, [h("th", { text: "CATEGORY" }), h("th", { text: "TRANSACTIONS" }), h("th", { className: "right", text: "TOTAL" })])]),
      ]);
      const body = h("tbody");
      groupRows.forEach(({ category, count, total }) => body.append(h("tr", {}, [
        h("td", {}, [h("div", { className: "transaction-cell" }, [categoryIcon(category, "category-icon small-category"), h("strong", { text: category.name })])]),
        h("td", { text: String(count) }),
        h("td", { className: "right amount-cell", text: formatMoney(total) }),
      ])));
      table.append(body);
      breakdown.append(h("div", { className: "table-wrap" }, [table]));
    } else breakdown.append(emptyState("▥", "No expenses in this period", "Try a different date range or add an expense."));
    content.append(breakdown);
  }

  function weeklyBuckets(start, end) {
    if (!isValidDate(start) || !isValidDate(end)) return [];
    const groups = new Map();
    const first = localDate(start), last = localDate(end);
    for (let date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
      const monday = new Date(date);
      monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
      const key = localISO(monday);
      if (!groups.has(key)) {
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);
        groups.set(key, { start: localISO(monday), end: localISO(sunday) });
      }
    }
    return [...groups.values()];
  }

  function monthsBetween(start, end) {
    if (!isValidDate(start) || !isValidDate(end)) return [];
    const first = localDate(start), last = localDate(end);
    const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
    const months = [];
    while (cursor <= last) {
      months.push(monthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
  }

  function filteredReportRows() {
    const filters = pageFilters.reports || { from: "", to: "", type: "all" };
    return state.transactions.filter((item) =>
      (!filters.from || item.date >= filters.from) &&
      (!filters.to || item.date <= filters.to) &&
      (filters.type === "all" || item.type === filters.type)
    ).sort(sortByDateDescending);
  }

  function reportStat(label, value) {
    return h("article", { className: "report-stat" }, [h("span", { text: label }), h("strong", { text: value })]);
  }

  function exportCsv(items) {
    if (!items.length) {
      showToast("There are no transactions in the selected range to export.", true);
      return;
    }
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const header = ["Title", "Amount", "Type", "Category", "Date", "Payment method", "Notes"];
    const lines = [header.map(escape).join(",")];
    items.forEach((item) => {
      const category = categoryById(item.categoryId);
      lines.push([item.title, Number(item.amount).toFixed(2), item.type, category?.name || "", item.date, item.paymentMethod, item.notes].map(escape).join(","));
    });
    downloadFile(`spendwise-transactions-${todayISO()}.csv`, `\uFEFF${lines.join("\r\n")}`, "text/csv;charset=utf-8");
    showToast("Filtered CSV downloaded.");
  }

  function downloadFile(name, data, type) {
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function renderSettings() {
    content.append(pageHeading("YOUR PREFERENCES", "Settings", "Adjust display preferences and manage your local data."));
    const grid = h("div", { className: "settings-grid" });
    const preferences = h("section", { className: "panel settings-card" }, [
      h("h2", { text: "Preferences" }),
      h("p", { text: "These settings apply across your SpendWise workspace." }),
    ]);
    const currencySelect = makeSelect("currencySetting", [["INR", "INR · ₹ Indian Rupee"], ["USD", "USD · $ US Dollar"], ["EUR", "EUR · € Euro"], ["GBP", "GBP · £ British Pound"]], state.preferences.currency, "filter-control");
    currencySelect.addEventListener("change", () => {
      state.preferences.currency = currencySelect.value;
      if (save()) {
        render();
        showToast("Currency preference updated. Saved amounts have not changed.");
      }
    });
    const themeSelect = makeSelect("themeSetting", [["light", "Light"], ["dark", "Dark"]], state.preferences.theme, "filter-control");
    themeSelect.addEventListener("change", () => {
      state.preferences.theme = themeSelect.value;
      if (save()) render();
    });
    const threshold = h("input", { id: "thresholdSetting", className: "filter-control", type: "number", min: "1", max: "100", step: "1", value: state.preferences.warningThreshold, "aria-label": "Budget warning threshold percentage" });
    threshold.addEventListener("change", () => {
      const value = Number(threshold.value);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        showToast("Warning threshold must be between 1 and 100 percent.", true);
        threshold.value = state.preferences.warningThreshold;
        return;
      }
      state.preferences.warningThreshold = value;
      if (save()) { render(); showToast("Budget warning threshold updated."); }
    });
    preferences.append(
      settingRow("Currency", "Displayed amounts only change format; your saved transaction amounts stay the same.", currencySelect),
      settingRow("Theme", "Choose a comfortable display appearance.", themeSelect),
      settingRow("Budget warning threshold", "Show a warning when this percentage of a budget is used.", threshold),
    );

    const backups = h("section", { className: "panel settings-card" }, [
      h("h2", { text: "Backup & restore" }),
      h("p", { text: "Export a portable copy of your categories, transactions, budgets, and preferences." }),
    ]);
    const exportBackup = button("Export JSON backup", "button-secondary", { onclick: () => {
      downloadFile(`spendwise-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), "application/json");
      showToast("JSON backup downloaded.");
    } });
    const importInput = h("input", { type: "file", accept: "application/json,.json", className: "file-input", id: "backupFile" });
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const parsed = validateData(JSON.parse(await file.text()));
        showDialog("Replace local data?", "Importing a backup replaces the current categories, transactions, budgets, and preferences on this device. Export a backup first if you need to keep the current data.", null, [
          button("Cancel", "button-light", closeDialog),
          button("Import and replace", "button-danger", () => {
            state = parsed;
            if (save()) {
              closeDialog();
              pageFilters = {};
              render();
              showToast("Backup validated and imported.");
            }
          }),
        ]);
      } catch (error) {
        showToast(error instanceof SyntaxError ? "This file is not valid JSON." : error.message || "The backup could not be imported.", true);
      } finally {
        importInput.value = "";
      }
    });
    const importButton = button("Import JSON backup", "button-secondary", { onclick: () => importInput.click() });
    backups.append(
      settingRow("Export backup", "Download a JSON copy for safekeeping.", exportBackup),
      settingRow("Import backup", "Replaces this browser’s current data after validation.", importButton),
    );
    backups.append(importInput);

    const samplePanel = h("section", { className: "panel settings-card" }, [
      h("h2", { text: "Explore with sample data" }),
      h("p", { text: "Adds clearly labeled example transactions and budgets only when your workspace is empty. Your saved records are never overwritten." }),
    ]);
    samplePanel.append(settingRow("Sample workspace", "Create example activity to preview reports and charts.", button("Load sample data", "button-secondary", { onclick: loadSampleData })));
    const clearPanel = h("section", { className: "panel settings-card" }, [
      h("h2", { text: "Clear local data" }),
      h("p", { text: "Permanently remove every SpendWise record from this browser. Export a backup first if you may want this data later." }),
    ]);
    clearPanel.append(settingRow("Clear all records", "This cannot be undone without a backup.", button("Clear all data", "button-danger", { onclick: confirmClearData })));
    grid.append(preferences, backups, samplePanel, clearPanel);
    content.append(grid, h("div", { className: "alert-card", style: { marginTop: "15px" }, text: "Privacy note: this app stores data only in browser LocalStorage. It is not secure authentication, cloud storage, or cross-device sync." }));
  }

  function settingRow(title, note, control) {
    return h("div", { className: "setting-row" }, [
      h("div", { className: "setting-copy" }, [h("strong", { text: title }), h("small", { text: note })]),
      control,
    ]);
  }

  function confirmClearData() {
    const input = field("Type DELETE to confirm", "clearConfirm", "text", "", { autocomplete: "off", placeholder: "DELETE" });
    const body = h("div", {}, [
      h("p", { className: "alert-card danger", text: "This will permanently clear all transactions, categories, budgets, and preferences from this browser." }),
      fieldWrap("Confirmation", input, true),
    ]);
    const clearButton = button("Delete everything", "button-danger", { onclick: () => {
      if (input.value.trim() !== "DELETE") {
        showToast("Type DELETE exactly to confirm.", true);
        input.focus();
        return;
      }
      try {
        localStorage.removeItem(STORAGE_KEY);
        state = {
          version: 1,
          categories: [],
          transactions: [],
          budgets: [],
          preferences: { currency: "USD", theme: "light", warningThreshold: 80 },
        };
        save();
        pageFilters = {};
        closeDialog();
        navigate("#dashboard");
        render();
        showToast("Local data cleared.");
      } catch {
        showToast("Could not clear browser storage.", true);
      }
    } });
    showDialog("Clear all SpendWise data?", "For extra safety, type DELETE below. This action cannot be undone.", body, [
      button("Cancel", "button-light", closeDialog),
      clearButton,
    ]);
    input.focus();
  }

  function loadSampleData() {
    if (state.transactions.length || state.budgets.length) {
      showToast("Sample data is only added to an empty workspace. Your existing records were left unchanged.", true);
      return;
    }
    if (!state.categories.length) {
      state.categories = DEFAULTS.map(([name, type, icon, color]) => ({
        id: uid(), name, type, icon, color, description: "", archived: false, createdAt: new Date().toISOString(),
      }));
    }
    const lookup = (name, type) => state.categories.find((category) => category.name === name && category.type === type && !category.archived);
    const food = lookup("Food & Dining", "expense");
    const transport = lookup("Transportation", "expense");
    const shopping = lookup("Shopping", "expense");
    const salary = lookup("Salary", "income");
    if (!food || !transport || !shopping || !salary) {
      showToast("Restore or create the starter categories before loading sample data.", true);
      return;
    }
    const now = new Date();
    const makeDate = (offset) => {
      const date = new Date(now);
      date.setDate(date.getDate() - offset);
      return localISO(date);
    };
    const examples = [
      ["Sample · Monthly paycheck", 3200, "income", salary, 2, "Bank transfer"],
      ["Sample · Grocery market", 64.5, "expense", food, 1, "Card"],
      ["Sample · Metro pass", 29, "expense", transport, 2, "Digital wallet"],
      ["Sample · Coffee & lunch", 18.75, "expense", food, 3, "Card"],
      ["Sample · Home essentials", 82.4, "expense", shopping, 5, "Card"],
      ["Sample · Weekend brunch", 36.2, "expense", food, 7, "Cash"],
      ["Sample · Freelance invoice", 475, "income", state.categories.find((item) => item.name === "Freelance" && item.type === "income"), 9, "Bank transfer"],
    ];
    state.transactions.push(...examples.filter((item) => item[3]).map(([title, amount, type, category, days, paymentMethod]) => ({
      id: uid(), title, amount, type, categoryId: category.id, date: makeDate(days), paymentMethod,
      notes: "Example record — sample data",
    })));
    state.budgets.push(
      { id: uid(), type: "overall", categoryId: null, month: monthKey(), amount: 950 },
      { id: uid(), type: "category", categoryId: food.id, month: monthKey(), amount: 260 },
      { id: uid(), type: "category", categoryId: transport.id, month: monthKey(), amount: 140 },
    );
    if (save()) {
      showToast(`Sample data loaded for ${new Date(`${monthKey()}-01T12:00:00`).toLocaleDateString(undefined, { month: "long" })}.`);
      pageFilters = {};
      render();
    }
  }

  function deleteTransaction(id) {
    const item = state.transactions.find((transaction) => transaction.id === id);
    if (!item) return;
    showDialog("Delete transaction?", `Delete “${item.title}” (${formatMoney(item.amount)})? This cannot be undone.`, null, [
      button("Cancel", "button-light", closeDialog),
      button("Delete transaction", "button-danger", () => {
        state.transactions = state.transactions.filter((transaction) => transaction.id !== id);
        save();
        closeDialog();
        render();
        showToast("Transaction deleted.");
      }),
    ]);
  }

  function deleteBudget(id) {
    const budget = state.budgets.find((item) => item.id === id);
    if (!budget) return;
    const label = budget.type === "overall" ? "overall budget" : `${categoryById(budget.categoryId)?.name || "category"} budget`;
    showDialog("Delete budget?", `Delete the ${label} for ${budget.month}? Transaction history will not be affected.`, null, [
      button("Cancel", "button-light", closeDialog),
      button("Delete budget", "button-danger", () => {
        state.budgets = state.budgets.filter((item) => item.id !== id);
        save();
        closeDialog();
        render();
        showToast("Budget deleted.");
      }),
    ]);
  }

  function handleActions(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, id } = target.dataset;
    if (action === "edit-transaction") navigate(`#transaction-edit/${encodeURIComponent(id)}`);
    else if (action === "delete-transaction") deleteTransaction(id);
    else if (action === "edit-category") navigate(`#category-edit/${encodeURIComponent(id)}`);
    else if (action === "delete-category") {
      const category = categoryById(id);
      if (category) showCategoryDelete(category);
    } else if (action === "restore-category") {
      const category = categoryById(id);
      if (!category) return;
      const duplicate = state.categories.some((item) => item.id !== id && item.type === category.type && item.name.toLocaleLowerCase() === category.name.toLocaleLowerCase());
      if (duplicate) {
        showToast("Rename the active duplicate before restoring this category.", true);
        return;
      }
      category.archived = false;
      save();
      render();
      showToast(`${category.name} restored.`);
    } else if (action === "edit-budget") navigate(`#budget-edit/${encodeURIComponent(id)}`);
    else if (action === "delete-budget") deleteBudget(id);
  }

  function setup() {
    state = readData();
    savedSnapshot = JSON.stringify(state);
    let hasSavedData = false;
    try { hasSavedData = localStorage.getItem(STORAGE_KEY) !== null; } catch { storageWarning = true; }
    if (!hasSavedData && !storageWarning) {
      try {
        const snapshot = JSON.stringify(state);
        localStorage.setItem(STORAGE_KEY, snapshot);
        savedSnapshot = snapshot;
      } catch { storageWarning = true; }
    }
    $("#menuToggle").addEventListener("click", () => {
      const isOpen = $("#sidebar").classList.toggle("sidebar-open");
      $("#menuToggle").setAttribute("aria-expanded", String(isOpen));
    });
    document.addEventListener("click", (event) => {
      if (window.innerWidth <= 760 && !$("#sidebar").contains(event.target) && !$("#menuToggle").contains(event.target)) {
        $("#sidebar").classList.remove("sidebar-open");
        $("#menuToggle").setAttribute("aria-expanded", "false");
      }
    });
    $("#quickAdd").addEventListener("click", () => navigate("#transaction-form"));
    document.addEventListener("click", handleActions);
    window.addEventListener("hashchange", render);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeDialog(); });
    document.addEventListener("keydown", (event) => {
      if (backdrop.hidden) return;
      if (event.key === "Escape") closeDialog();
      if (event.key === "Tab") {
        const focusable = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    if (!location.hash) history.replaceState(null, "", "#dashboard");
    render();
    window.addEventListener("resize", () => {
      if (window.innerWidth > 760) {
        $("#sidebar").classList.remove("sidebar-open");
        $("#menuToggle").setAttribute("aria-expanded", "false");
      }
    });
  }

  setup();
})();
