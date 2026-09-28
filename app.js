const KEYS = {
  sales: "iphone_store_sales",
  cash: "iphone_store_cash",
  inventory: "iphone_store_inventory",
  receivables: "go_apple_pending_receivables",
  cashWeekCloses: "go_apple_cash_week_closes",
  invoices: "go_apple_invoices",
  pipelineLeads: "go_apple_pipeline_leads",
  sellers: "go_apple_salespeople",
  goals: "go_apple_business_goals",
  dashboardMonth: "go_apple_dashboard_month_key",
  vendedoresStatsMonth: "go_apple_vendedores_stats_month",
  configSubpanel: "go_apple_config_subpanel",
  viewFilters: "go_apple_view_filters",
  uiTheme: "go_apple_ui_theme",
  deviceHistory: "go_apple_device_unit_history",
  creativos: "go_apple_creativos",
  creativosConfig: "go_apple_creativos_config",
};

const UI_THEME_IDS = ["app", "app-oscuro", "oceano", "bosque", "magma", "uva", "grafito"];

const UI_THEME_META = {
  app: "#f4f5f7",
  "app-oscuro": "#07080d",
  oceano: "#1e3a5f",
  bosque: "#134e4a",
  magma: "#7c2d12",
  uva: "#4c1d95",
  grafito: "#1e293b",
};

function applyUiTheme(themeId) {
  const t = UI_THEME_IDS.includes(themeId) ? themeId : "oceano";
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEYS.uiTheme, t);
  } catch (_) {}
  const m = document.getElementById("meta-theme-color");
  if (m) m.setAttribute("content", UI_THEME_META[t] || UI_THEME_META.oceano);
  document.querySelectorAll("[data-theme-select]").forEach((el) => {
    if (el instanceof HTMLSelectElement) el.value = t;
  });
}

function initUiThemeControls() {
  const current = document.documentElement.dataset.theme || "oceano";
  const t = UI_THEME_IDS.includes(current) ? current : "oceano";
  document.querySelectorAll("[data-theme-select]").forEach((el) => {
    if (!(el instanceof HTMLSelectElement)) return;
    el.value = t;
    el.addEventListener("change", () => applyUiTheme(el.value));
  });
}

const DEFAULT_GOALS = {
  incomeMonthlyUsd: 0,
  profitMonthlyUsd: 0,
  unitsMonthly: 0,
  /** Cotización dólar blue: ARS por 1 US$ (inventario muestra precio en pesos = precio US$ × este valor). */
  dolarBlueArsPerUsd: 0,
  /** Reparto sobre las entradas del mes (Reserva + Restock + Socios = 100). middlePct = Restock en la UI. */
  reservePct: 30,
  middlePct: 50,
  partnersPct: 20,
};

let goalsFormHydrated = false;

let supabaseClient = null;
/** Si es true, ventas/caja/inventario se leen y escriben en Supabase (no solo en localStorage). */
let useCloud = false;
/** Conexión o primera carga desde Supabase en curso. */
let cloudConnecting = false;
/** Panel de login visible (hay Supabase en config y aún no hay sesión en la app). */
let loginPanelVisible = false;
let cacheSales = [];
let cacheCash = [];
let cacheInventory = [];
let cacheReceivables = [];
let cacheInvoices = [];
let cachePipelineLeads = [];
let cacheSellers = [];
/** Fila crm_settings en nube: dólar blue (ARS/US$). null = sin fila o tabla no migrada. */
let cacheCrmSettings = null;
let cacheDeviceHistory = [];

let cloudRealtimeChannel = null;
let realtimeRefreshTimer = null;

const STAFF_TABS = new Set(["inventario", "simulador-cuotas"]);
const STAFF_SESSION_KEY = "go_apple_staff_ok";

function isStaffPath() {
  const path = (location.pathname || "").replace(/\/+$/, "") || "/";
  if (/\/empleados(\.html)?$/.test(path)) return true;
  const q = new URLSearchParams(location.search);
  return q.get("modo") === "empleado" || q.get("staff") === "1";
}

function isStaffMode() {
  return isStaffPath();
}

function isStaffPinRequired() {
  return Boolean(getStaffPinFromConfig());
}

function hasStaffUnlock() {
  if (!isStaffPinRequired()) return true;
  try {
    return sessionStorage.getItem(STAFF_SESSION_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function setStaffUnlock(ok) {
  try {
    if (ok) sessionStorage.setItem(STAFF_SESSION_KEY, "1");
    else sessionStorage.removeItem(STAFF_SESSION_KEY);
  } catch (_) {
    /* — */
  }
}

function getStaffPinFromConfig() {
  return String(window.APP_STAFF_PIN || "").trim();
}

function showStaffGate() {
  const o = document.getElementById("staff-overlay");
  if (!o) return;
  o.hidden = false;
  o.setAttribute("aria-hidden", "false");
  const input = document.getElementById("staff-pin");
  if (input) setTimeout(() => input.focus(), 40);
}

function hideStaffGate() {
  const o = document.getElementById("staff-overlay");
  if (!o) return;
  o.hidden = true;
  o.setAttribute("aria-hidden", "true");
}

function applyStaffUi() {
  document.body.classList.add("app-staff-mode");
  document.documentElement.classList.add("app-staff-boot", "app-staff-ready");
  document.title = "GO APPLE · Empleados";
  const sub = document.querySelector(".sidebar-brand-sub");
  if (sub) sub.textContent = "Empleados";
  const exitBtn = document.getElementById("btn-staff-exit");
  if (exitBtn) exitBtn.hidden = !isStaffPinRequired();
  const active = document.querySelector(".sidebar-nav .tab-btn.active")?.dataset.tab;
  if (!STAFF_TABS.has(active)) switchTab("inventario");
  else updateMainHeader(active);
}

function blockStaffWrite(msg) {
  if (!isStaffMode()) return false;
  alert(msg || "En el acceso de empleados no se puede modificar el stock.");
  return true;
}

function setStaffPinError(msg) {
  const el = document.getElementById("staff-pin-error");
  if (!el) return;
  if (msg) {
    el.hidden = false;
    el.textContent = msg;
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

function bindStaffGate() {
  if (!isStaffPinRequired()) return;
  const form = document.getElementById("staff-pin-form");
  if (!form || form.dataset.bound === "1") return;
  form.dataset.bound = "1";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pin = (document.getElementById("staff-pin")?.value || "").trim();
    const expected = getStaffPinFromConfig();
    if (!expected) {
      setStaffPinError("Falta configurar APP_STAFF_PIN en config.js.");
      return;
    }
    if (pin !== expected) {
      setStaffPinError("PIN incorrecto.");
      const input = document.getElementById("staff-pin");
      if (input) {
        input.value = "";
        input.focus();
      }
      return;
    }
    setStaffPinError("");
    setStaffUnlock(true);
    hideStaffGate();
    if (appShell) appShell.hidden = false;
    applyStaffUi();
    void initApp();
  });
}

document.getElementById("btn-staff-exit")?.addEventListener("click", () => {
  setStaffUnlock(false);
  location.reload();
});

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

const appShell = document.getElementById("app-shell");
const btnLogoutSupabase = document.getElementById("btn-logout-supabase");
const connectionStatus = document.getElementById("connection-status");
const connectionStatusLead = document.getElementById("connection-status-lead");
const connectionStatusDetail = document.getElementById("connection-status-detail");

const saleForm = document.getElementById("sale-form");
const saleDate = document.getElementById("sale-date");
const saleClient = document.getElementById("sale-client");
const salePhone = document.getElementById("sale-phone");
const saleIg = document.getElementById("sale-ig");
const saleModel = document.getElementById("sale-model");
const saleColor = document.getElementById("sale-color");
const saleStorage = document.getElementById("sale-storage");
const saleBattery = document.getElementById("sale-battery");
const saleImei = document.getElementById("sale-imei");
const saleQuantity = document.getElementById("sale-quantity");
const salePrice = document.getElementById("sale-price");
const saleCost = document.getElementById("sale-cost");
const salePickInventory = document.getElementById("sale-pick-inventory");
const salePayment = document.getElementById("sale-payment");
const saleTradeInDesc = document.getElementById("sale-trade-in-desc");
const saleTradeInValue = document.getElementById("sale-trade-in-value");
const saleTradeInModel = document.getElementById("sale-trade-in-model");
const saleTradeInColor = document.getElementById("sale-trade-in-color");
const saleTradeInStorage = document.getElementById("sale-trade-in-storage");
const saleTradeInBattery = document.getElementById("sale-trade-in-battery");
const saleTradeInInvPrice = document.getElementById("sale-trade-in-inv-price");
const salePayCash = document.getElementById("sale-pay-cash");
const salePayTransfer = document.getElementById("sale-pay-transfer");
const salePayCard = document.getElementById("sale-pay-card");
const salePayOther = document.getElementById("sale-pay-other");
const saleClientSelect = document.getElementById("sale-client-select");
const saleSeller = document.getElementById("sale-seller");
const saleAddCartBtn = document.getElementById("sale-add-cart-btn");
const saleCartBody = document.getElementById("sale-cart-body");
const saleCartEmpty = document.getElementById("sale-cart-empty");
const saleCartTableWrap = document.getElementById("sale-cart-table-wrap");
const saleCartClearBtn = document.getElementById("sale-cart-clear-btn");
const saleSummaryGross = document.getElementById("sale-summary-gross");
const saleSummaryTrade = document.getElementById("sale-summary-trade");
const saleSummaryNet = document.getElementById("sale-summary-net");
const saleModal = document.getElementById("sale-modal");
const btnOpenSaleModal = document.getElementById("btn-open-sale-modal");
const saleModalClose = document.getElementById("sale-modal-close");
const saleModalCancel = document.getElementById("sale-modal-cancel");
const saleModalBackdrop = document.getElementById("sale-modal-backdrop");
const saleModalTitleEl = document.getElementById("sale-modal-title");
const saleEditHintEl = document.getElementById("sale-edit-hint");
const saleFormSubmitBtn = document.getElementById("sale-form-submit-btn");
const salesBody = document.getElementById("sales-body");
const pipelineBoard = document.getElementById("pipeline-board");
const pipelineModal = document.getElementById("pipeline-modal");
const btnOpenPipelineModal = document.getElementById("btn-open-pipeline-modal");
const pipelineModalClose = document.getElementById("pipeline-modal-close");
const pipelineModalCancel = document.getElementById("pipeline-modal-cancel");
const pipelineModalBackdrop = document.getElementById("pipeline-modal-backdrop");
const pipelineModalTitleEl = document.getElementById("pipeline-modal-title");
const pipelineLeadForm = document.getElementById("pipeline-lead-form");
const warrantyBody = document.getElementById("warranty-body");
const warrantyFilter = document.getElementById("warranty-filter");
const warrantySearch = document.getElementById("warranty-search");
const warrantyEmpty = document.getElementById("warranty-empty");
const warrantyCountBadge = document.getElementById("warranty-count-badge");

const cashForm = document.getElementById("cash-form");
const cashType = document.getElementById("cash-type");
const cashDate = document.getElementById("cash-date");
const cashConcept = document.getElementById("cash-concept");
const cashAmount = document.getElementById("cash-amount");
const cashRepartoDestWrap = document.getElementById("cash-reparto-dest-wrap");
const cashRepartoDest = document.getElementById("cash-reparto-dest");
const cashRepartoDestHint = document.getElementById("cash-reparto-dest-hint");
const cashBody = document.getElementById("cash-body");
const cashFormSubmitBtn = document.getElementById("cash-form-submit-btn");
const cashEditHintEl = document.getElementById("cash-edit-hint");
const cashModal = document.getElementById("cash-modal");
const cashModalTitle = document.getElementById("cash-modal-title");
const cashModalBackdrop = document.getElementById("cash-modal-backdrop");
const cashModalClose = document.getElementById("cash-modal-close");
const cashModalCancel = document.getElementById("cash-modal-cancel");
const btnOpenCashModal = document.getElementById("btn-open-cash-modal");
const invoiceForm = document.getElementById("invoice-form");
const invoiceSaleId = document.getElementById("invoice-sale-id");
const invoiceType = document.getElementById("invoice-type");
const invoiceDate = document.getElementById("invoice-date");
const invoiceTaxPct = document.getElementById("invoice-tax-pct");
const invoiceNotes = document.getElementById("invoice-notes");
const invoicesBody = document.getElementById("invoices-body");
const btnInvoiceExport = document.getElementById("btn-invoice-export");
const invoiceModalTitle = document.getElementById("invoice-modal-title");
const invoiceEditHintEl = document.getElementById("invoice-edit-hint");
const invoiceFormSubmitBtn = document.getElementById("invoice-form-submit-btn");
const invoiceModal = document.getElementById("invoice-modal");
const invoiceModalBackdrop = document.getElementById("invoice-modal-backdrop");
const invoiceModalClose = document.getElementById("invoice-modal-close");
const invoiceModalCancel = document.getElementById("invoice-modal-cancel");
const btnOpenInvoiceModal = document.getElementById("btn-open-invoice-modal");

const inventoryForm = document.getElementById("inventory-form");
const invModel = document.getElementById("inv-model");
const invColor = document.getElementById("inv-color");
const invStorage = document.getElementById("inv-storage");
const invBattery = document.getElementById("inv-battery");
const invCategory = document.getElementById("inv-category");
const invSerial = document.getElementById("inv-serial");
const invImei = document.getElementById("inv-imei");
const invStockSearch = document.getElementById("inv-stock-search");
const invStockFilter = document.getElementById("inv-stock-filter");
const invNotes = document.getElementById("inv-notes");
const invQuantity = document.getElementById("inv-quantity");
const invPrice = document.getElementById("inv-price");
const invCost = document.getElementById("inv-cost");
const btnOpenInvBulkModal = document.getElementById("btn-open-inv-bulk-modal");
const invBulkModal = document.getElementById("inv-bulk-modal");
const invBulkModalBackdrop = document.getElementById("inv-bulk-modal-backdrop");
const invBulkModalClose = document.getElementById("inv-bulk-modal-close");
const invBulkModalCancel = document.getElementById("inv-bulk-modal-cancel");
const invBulkPaste = document.getElementById("inv-bulk-paste");
const invBulkFile = document.getElementById("inv-bulk-file");
const invBulkFileTrigger = document.getElementById("inv-bulk-file-trigger");
const invBulkFileNames = document.getElementById("inv-bulk-file-names");
const invBulkParseBtn = document.getElementById("inv-bulk-parse-btn");
const invBulkImportBtn = document.getElementById("inv-bulk-import-btn");
const invBulkStatus = document.getElementById("inv-bulk-status");
const invBulkPreviewWrap = document.getElementById("inv-bulk-preview-wrap");
const invBulkPreviewBody = document.getElementById("inv-bulk-preview-body");
const invUnitModal = document.getElementById("inv-unit-modal");
const invUnitModalBackdrop = document.getElementById("inv-unit-modal-backdrop");
const invUnitModalClose = document.getElementById("inv-unit-modal-close");
const invUnitModalDone = document.getElementById("inv-unit-modal-done");
const invUnitModalEdit = document.getElementById("inv-unit-modal-edit");
const invUnitModalDelete = document.getElementById("inv-unit-modal-delete");
const invUnitModalCopyMsg = document.getElementById("inv-unit-modal-copy-msg");
const invUnitModalTitle = document.getElementById("inv-unit-modal-title");
const invUnitModalBody = document.getElementById("inv-unit-modal-body");
const deviceHistoryModal = document.getElementById("device-history-modal");
const deviceHistoryModalBackdrop = document.getElementById("device-history-modal-backdrop");
const deviceHistoryModalClose = document.getElementById("device-history-modal-close");
const deviceHistoryModalDone = document.getElementById("device-history-modal-done");
const btnOpenDeviceHistoryModal = document.getElementById("btn-open-device-history-modal");
const deviceHistoryQuery = document.getElementById("device-history-query");
const deviceHistorySearchBtn = document.getElementById("device-history-search-btn");
const deviceHistorySummary = document.getElementById("device-history-summary");
const deviceHistoryTimeline = document.getElementById("device-history-timeline");
const deviceHistoryEmpty = document.getElementById("device-history-empty");
const techKpiUnits = document.getElementById("tech-kpi-units");
const techKpiRepairCost = document.getElementById("tech-kpi-repair-cost");
const techKpiCashOut = document.getElementById("tech-kpi-cash-out");
const techKpiStockValue = document.getElementById("tech-kpi-stock-value");
const techKpiWarrantyCost = document.getElementById("tech-kpi-warranty-cost");
const techSendForm = document.getElementById("tech-send-form");
const techSendPick = document.getElementById("tech-send-pick");
const techSendNotes = document.getElementById("tech-send-notes");
const techWarrantyForm = document.getElementById("tech-warranty-form");
const techWarrantyPick = document.getElementById("tech-warranty-pick");
const techWarrantyPickHint = document.getElementById("tech-warranty-pick-hint");
const techWarrantyNotes = document.getElementById("tech-warranty-notes");
const techExpenseForm = document.getElementById("tech-expense-form");
const techExpensePick = document.getElementById("tech-expense-pick");
const techExpenseDate = document.getElementById("tech-expense-date");
const techExpenseAmount = document.getElementById("tech-expense-amount");
const techExpenseConcept = document.getElementById("tech-expense-concept");
const techExpenseCash = document.getElementById("tech-expense-cash");
const techUnitsList = document.getElementById("tech-units-list");
const techUnitsEmpty = document.getElementById("tech-units-empty");
const techCashList = document.getElementById("tech-cash-list");
const techCashEmpty = document.getElementById("tech-cash-empty");
const techCashDetails = document.getElementById("tech-cash-details");
const btnTechWarranty = document.getElementById("btn-tech-warranty");
const btnTechStock = document.getElementById("btn-tech-stock");
const btnTechExpense = document.getElementById("btn-tech-expense");
const btnTechToggleCash = document.getElementById("btn-tech-toggle-cash");
const techWarrantyModal = document.getElementById("tech-warranty-modal");
const techWarrantyModalBackdrop = document.getElementById("tech-warranty-modal-backdrop");
const techWarrantyModalClose = document.getElementById("tech-warranty-modal-close");
const techWarrantyModalCancel = document.getElementById("tech-warranty-modal-cancel");
const techSendModal = document.getElementById("tech-send-modal");
const techSendModalBackdrop = document.getElementById("tech-send-modal-backdrop");
const techSendModalClose = document.getElementById("tech-send-modal-close");
const techSendModalCancel = document.getElementById("tech-send-modal-cancel");
const techExpenseModal = document.getElementById("tech-expense-modal");
const techExpenseModalBackdrop = document.getElementById("tech-expense-modal-backdrop");
const techExpenseModalClose = document.getElementById("tech-expense-modal-close");
const techExpenseModalCancel = document.getElementById("tech-expense-modal-cancel");

let invUnitModalOpenId = null;
const inventoryStock = document.getElementById("inventory-stock");
const inventoryModalTitle = document.getElementById("inventory-modal-title");
const inventorySectionHintEl = document.getElementById("inventory-section-hint");
const inventoryEditHintEl = document.getElementById("inventory-edit-hint");
const inventoryFormSubmitBtn = document.getElementById("inventory-form-submit-btn");
const inventoryModal = document.getElementById("inventory-modal");
const inventoryModalBackdrop = document.getElementById("inventory-modal-backdrop");
const inventoryModalClose = document.getElementById("inventory-modal-close");
const inventoryModalCancel = document.getElementById("inventory-modal-cancel");
const btnOpenInventoryModal = document.getElementById("btn-open-inventory-modal");
const recvEditHintEl = document.getElementById("recv-edit-hint");
const recvFormSubmitBtn = document.getElementById("recv-form-submit-btn");
const receivableModal = document.getElementById("receivable-modal");
const receivableModalTitle = document.getElementById("receivable-modal-title");
const receivableModalBackdrop = document.getElementById("receivable-modal-backdrop");
const receivableModalClose = document.getElementById("receivable-modal-close");
const receivableModalCancel = document.getElementById("receivable-modal-cancel");
const btnOpenReceivableModal = document.getElementById("btn-open-receivable-modal");

const sellerForm = document.getElementById("seller-form");
const sellerName = document.getElementById("seller-name");
const sellerCommissionPct = document.getElementById("seller-commission-pct");
const sellerActive = document.getElementById("seller-active");
const sellersBody = document.getElementById("sellers-body");
const sellerStatsBody = document.getElementById("seller-stats-body");
const sellerFormSubmitBtn = document.getElementById("seller-form-submit-btn");
const sellerEditHintEl = document.getElementById("seller-edit-hint");
const btnSellerCancelEdit = document.getElementById("btn-seller-cancel-edit");

const kpiEntra = document.getElementById("kpi-entra");
const kpiSale = document.getElementById("kpi-sale");
const kpiGanancia = document.getElementById("kpi-ganancia");
const kpiRestock = document.getElementById("kpi-restock");
const kpiPctRestock = document.getElementById("kpi-pct-restock");
const kpiVentas = document.getElementById("kpi-ventas");
const kpiStock = document.getElementById("kpi-stock");
const kpiStockValue = document.getElementById("kpi-stock-value");
const kpiWarrantyActive = document.getElementById("kpi-warranty-active");
const kpiReserva = document.getElementById("kpi-reserva");
const kpiSocios = document.getElementById("kpi-socios");
const kpiPctReserva = document.getElementById("kpi-pct-reserva");
const kpiPctSocios = document.getElementById("kpi-pct-socios");
const kpiCuotasCobrar = document.getElementById("kpi-cuotas-cobrar");

const WARRANTY_DAYS = 30;

/** Líneas del carrito de venta (solo en memoria hasta guardar). */
let saleCart = [];

let editingSaleId = null;
let saleModalEditMode = false;
let editingCashId = null;
let editingInventoryId = null;
let editingReceivableId = null;
let editingPipelineId = null;
let editingInvoiceId = null;
let editingSellerId = null;

function currency(value) {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "USD" }).format(value);
}

function getDolarBlueArsPerUsd() {
  const v = Number(readGoals().dolarBlueArsPerUsd);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Pesos argentinos (sin decimales); para montos derivados del blue. */
function currencyArs(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(numeric(value, 0)));
}

/** Cuotas en tarjetas: formato corto legible en español (ej. "245 mil"). */
function formatArsCompact(value) {
  const n = Math.round(numeric(value, 0));
  if (n <= 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10 ? `${Math.round(m)} mill.` : `${m.toFixed(1).replace(".", ",")} mill.`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)} mil`;
  return String(n);
}

/** Cuota mensual ref.: (precio LISTA ARS × coef. financiación) ÷ cuotas. Ver inventario. */
const INV_CUOTA3_ARS_MULT = 1.1518;
const INV_CUOTA6_ARS_MULT = 1.2815;
/** Ref. POS tasa 83%: $999.999,99 → total $1.583.752,78 / 12 cuotas. */
const INV_CUOTA12_ARS_MULT = 1.5837528;
/** Ref. POS tasa 83%: $999.999,99 → total $1.933.938,40 / 18 cuotas. */
const INV_CUOTA18_ARS_MULT = 1.9339384;
/** Precio lista / tarjeta = contado ARS × este factor (+10%). Las cuotas salen de lista. */
const INV_LISTA_MARKUP = 1.1;

function listaArsFromContado(contadoArs) {
  const p = Math.round(numeric(contadoArs, 0));
  if (p <= 0) return 0;
  return Math.round(p * INV_LISTA_MARKUP);
}

const CUOTA_SIM_PLANS = [
  { n: 3, mult: INV_CUOTA3_ARS_MULT },
  { n: 6, mult: INV_CUOTA6_ARS_MULT },
  { n: 12, mult: INV_CUOTA12_ARS_MULT },
  { n: 18, mult: INV_CUOTA18_ARS_MULT },
];

function cuotaMonthlyFromPriceArs(priceArs, n, mult) {
  const p = Math.round(numeric(priceArs, 0));
  if (p <= 0 || n <= 0) return 0;
  return Math.round((p * mult) / n);
}

function cuotaTotalFromPriceArs(priceArs, mult) {
  const p = Math.round(numeric(priceArs, 0));
  if (p <= 0) return 0;
  return Math.round(p * mult);
}

/** Parsea monto ARS: "999999", "999.999,99" o "999999.99". */
function parseArsInput(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim().replace(/\s/g, "").replace(/\$/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && (!hasDot || s.lastIndexOf(",") > s.lastIndexOf("."))) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  return numeric(s, 0);
}

function computeCuotaSimPlans(priceArs) {
  const p = Math.round(numeric(priceArs, 0));
  return CUOTA_SIM_PLANS.map(({ n, mult }) => ({
    n,
    monthly: cuotaMonthlyFromPriceArs(p, n, mult),
    total: cuotaTotalFromPriceArs(p, mult),
  }));
}

/** Valores persistidos en Supabase / localStorage (claves snake para upsert a la API).
 *  price_ars = contado; cuotas se calculan sobre lista (contado + 10%). */
function computeInventoryArsFields(unitPriceUsd) {
  const rate = getDolarBlueArsPerUsd();
  if (!rate || rate <= 0) {
    return {
      price_ars: 0,
      cuota_3_ars: 0,
      cuota_6_ars: 0,
      cuota_12_ars: 0,
      cuota_18_ars: 0,
    };
  }
  const p = numeric(unitPriceUsd, 0);
  const priceArs = Math.round(p * rate);
  const listaArs = listaArsFromContado(priceArs);
  return {
    price_ars: priceArs,
    cuota_3_ars: cuotaMonthlyFromPriceArs(listaArs, 3, INV_CUOTA3_ARS_MULT),
    cuota_6_ars: cuotaMonthlyFromPriceArs(listaArs, 6, INV_CUOTA6_ARS_MULT),
    cuota_12_ars: cuotaMonthlyFromPriceArs(listaArs, 12, INV_CUOTA12_ARS_MULT),
    cuota_18_ars: cuotaMonthlyFromPriceArs(listaArs, 18, INV_CUOTA18_ARS_MULT),
  };
}

function localArsCamelFromUsd(unitPriceUsd) {
  const f = computeInventoryArsFields(unitPriceUsd);
  return {
    priceArs: f.price_ars,
    cuota3Ars: f.cuota_3_ars,
    cuota6Ars: f.cuota_6_ars,
    cuota12Ars: f.cuota_12_ars,
    cuota18Ars: f.cuota_18_ars,
  };
}

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeList(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error("writeList overflow, cleaning large fields:", e);
    if (Array.isArray(data)) {
      data.forEach((item) => { delete item.generatedImages; });
      try { localStorage.setItem(key, JSON.stringify(data)); } catch (e2) { console.error("writeList still fails:", e2); }
    }
  }
}

/* ── IndexedDB for large blobs (generated images) ── */
const IMGDB_NAME = "ga_crm_images";
const IMGDB_STORE = "images";
let _imgDb = null;

function openImgDB() {
  if (_imgDb) return Promise.resolve(_imgDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMGDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IMGDB_STORE); };
    req.onsuccess = () => { _imgDb = req.result; resolve(_imgDb); };
    req.onerror = () => reject(req.error);
  });
}

async function saveGeneratedImages(creativoId, images) {
  const db = await openImgDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMGDB_STORE, "readwrite");
    tx.objectStore(IMGDB_STORE).put(images, creativoId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadGeneratedImages(creativoId) {
  const db = await openImgDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMGDB_STORE, "readonly");
    const req = tx.objectStore(IMGDB_STORE).get(creativoId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteGeneratedImages(creativoId) {
  try {
    const db = await openImgDB();
    const tx = db.transaction(IMGDB_STORE, "readwrite");
    tx.objectStore(IMGDB_STORE).delete(creativoId);
  } catch (e) { /* ignore */ }
}

function isCloudConfigured() {
  const url = window.APP_SUPABASE_URL || "";
  const key = window.APP_SUPABASE_ANON_KEY || "";
  return url.startsWith("http") && key.length > 20;
}

/** Contraseña en config; acepta typo PASSW0RD (cero) por error al tipear. */
function getSupabasePasswordFromConfig() {
  return (window.APP_SUPABASE_PASSWORD || window.APP_SUPABASE_PASSW0RD || "").trim();
}

function getSupabaseHost() {
  try {
    return new URL(window.APP_SUPABASE_URL || "").hostname || "";
  } catch {
    return "";
  }
}

function formatAuthError(error) {
  const m =
    typeof error === "string"
      ? error
      : (error && (error.message || error.msg || error.error_description)) || "";
  if (!m) return "Error desconocido.";
  if (/email logins are disabled|email provider is disabled|email.*login.*disabled|email.*sign.?in.*disabled/i.test(m)) {
    return "Supabase tiene desactivado el login con email. Dashboard: Authentication → Providers → Email → activá el proveedor (Enable). Si ves PASSW0RD en config.js, corregilo a APP_SUPABASE_PASSWORD (letra O, no cero).";
  }
  if (/invalid login|invalid credentials|invalid_grant/i.test(m)) {
    return "Email o contraseña incorrectos. En Supabase la contraseña suele ser de al menos 6 caracteres: si usás \"1234\", cambiala en Authentication → Users (icono de usuario → Reset password) o creá el usuario de nuevo. Revisá también que el email sea exactamente el del usuario en tu proyecto.";
  }
  if (/email not confirmed|not confirmed/i.test(m)) {
    return "Tenés que confirmar el email (revisá la bandeja) o desactivá \"Confirm email\" en Supabase → Authentication → Providers → Email.";
  }
  if (/password.*6|at least 6|least 6/i.test(m)) {
    return "La contraseña debe tener al menos 6 caracteres. Elegí otra en Supabase o al crear la cuenta.";
  }
  if (/signup|sign up|signups are disabled/i.test(m)) {
    return "En tu proyecto Supabase está desactivado crear cuentas nuevas por email. Opciones: (1) Supabase → Authentication → Providers → Email → activá \"Allow new users to sign up\". (2) O no uses \"Crear cuenta\": andá a Authentication → Users → Add user, creá el usuario ahí y después usá solo \"Entrar\" en esta app.";
  }
  if (/anonymous sign-ins are disabled|anonymous.*disabled|anon.*disabled/i.test(m)) {
    return "Activá el acceso anónimo en Supabase: Authentication → Providers → Anonymous → Enable. Así la app se conecta sola sin email.";
  }
  return m;
}

/** Mensaje claro cuando falta una columna en `sales` (migración no corrida en Supabase). */
function formatSaleSaveError(err) {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : (err && err.message) || String(err || "");
  if (/schema cache|could not find the ['"][^'"]+['"] column of ['"]sales['"]/i.test(msg)) {
    if (/ig_handle/i.test(msg)) {
      return (
        "Falta la columna ig_handle en la tabla sales.\n\n" +
        "En Supabase: SQL → ejecutá CRM/supabase/migration_sales_ig_handle.sql\n\n" +
        "Luego recargá esta página.\n\n— " +
        msg
      );
    }
    if (/seller_id|commission_pct_applied|commission_amount/i.test(msg)) {
      return (
        "Faltan columnas de vendedores en sales o no existe la tabla salespeople.\n\n" +
        "En Supabase: SQL → ejecutá CRM/supabase/migration_sales_sellers.sql\n\n" +
        "Luego recargá esta página.\n\n— " +
        msg
      );
    }
    return (
      "Tu tabla sales en Supabase no tiene las columnas nuevas (pagos, canje, inventario).\n\n" +
      "En Supabase: SQL → New query → pegá y ejecutá el archivo del proyecto:\n" +
      "CRM/supabase/migration_sales_full_upgrade.sql\n\n" +
      "Luego recargá esta página.\n\n— " +
      msg
    );
  }
  return msg || "Error al guardar venta.";
}

/** Supabase/PostgREST suele devolver objetos que no son `instanceof Error` → evita alert("[object Object]"). */
function formatDbClientError(err) {
  if (err == null) return "Error desconocido.";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "Error.";
  if (typeof err === "object") {
    const m =
      err.message ||
      err.msg ||
      err.error_description ||
      err.details ||
      (typeof err.error === "string" ? err.error : null) ||
      (err.error && err.error.message);
    if (m) return String(m);
    try {
      return JSON.stringify(err);
    } catch {
      return "Error al comunicar con la base.";
    }
  }
  return String(err);
}

/** Aclara el error típico cuando falta la migración de vendedores en Supabase. */
function alertSellerDbError(err) {
  let msg = formatDbClientError(err);
  if (/salespeople|schema cache.*salespeople|relation.*salespeople|does not exist.*salespeople/i.test(msg)) {
    msg +=
      "\n\nSolución: en Supabase → SQL → New query → abrí el archivo del proyecto CRM/supabase/migration_sales_sellers.sql, pegá todo el contenido, ejecutá (Run), y recargá esta página.";
  }
  alert(msg);
}

function getCreateClient() {
  const m = window.supabase;
  if (!m) return null;
  if (typeof m.createClient === "function") return m.createClient.bind(m);
  if (m.default && typeof m.default.createClient === "function") return m.default.createClient.bind(m.default);
  return null;
}

/** Tras signIn, la sesión a veces no viene en `data.session` o tarda un instante en persistir en storage. */
async function obtainSessionAfterSignIn(signInData) {
  if (signInData?.session) {
    return signInData.session;
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const { data: wrap, error } = await supabaseClient.auth.getSession();
    if (error) {
      console.warn("getSession tras login:", error.message);
    }
    if (wrap?.session) {
      return wrap.session;
    }
  }

  if (signInData?.user) {
    const { data: ref, error: refErr } = await supabaseClient.auth.refreshSession();
    if (!refErr && ref?.session) {
      return ref.session;
    }
    if (refErr) {
      console.warn("refreshSession tras login:", refErr.message);
    }
  }

  const { data: last } = await supabaseClient.auth.getSession();
  return last?.session ?? null;
}

/**
 * Lee ?email= y ?password= de la URL, los quita del historial (replaceState) y devuelve los valores.
 * Opcional al sincronizar; usá encodeURIComponent en la contraseña si tiene caracteres especiales.
 */
function readAndStripLoginFromUrl() {
  let email = "";
  let password = "";
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("email") && !u.searchParams.has("password")) {
      return { email: "", password: "" };
    }
    email = (u.searchParams.get("email") || "").trim();
    password = u.searchParams.get("password") || "";
    u.searchParams.delete("email");
    u.searchParams.delete("password");
    const q = u.searchParams.toString();
    const path = `${u.pathname}${q ? `?${q}` : ""}${u.hash}`;
    window.history.replaceState({}, "", path || "/");
  } catch {
    /* vacío */
  }
  return { email, password };
}

async function tryRestoreStoredSession() {
  if (!supabaseClient) {
    return { session: null, error: null };
  }
  try {
    const gs = await Promise.race([
      supabaseClient.auth.getSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("__skip_getsession__")), 5000)),
    ]);
    return { session: gs?.data?.session ?? null, error: null };
  } catch (e) {
    if (e?.message === "__skip_getsession__") {
      return { session: null, error: null };
    }
    console.warn("getSession:", e);
    return { session: null, error: null };
  }
}

async function signInWithPasswordFlow(email, password) {
  try {
    const pw = await Promise.race([
      supabaseClient.auth.signInWithPassword({ email, password }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("__pw_timeout__")), 20000)),
    ]);
    if (pw?.error) {
      return { session: null, error: pw.error };
    }
    const session = await obtainSessionAfterSignIn(pw.data);
    if (session) {
      return { session, error: null };
    }
  } catch (e) {
    if (e?.message === "__pw_timeout__") {
      return { session: null, error: new Error("El login tardó demasiado. Reintentá.") };
    }
    return { session: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
  return { session: null, error: new Error("No se obtuvo sesión tras el login.") };
}

/**
 * Login anónimo vía REST: POST /auth/v1/signup + setSession.
 */
async function signInAnonymousViaRest() {
  const base = (window.APP_SUPABASE_URL || "").replace(/\/$/, "");
  const key = window.APP_SUPABASE_ANON_KEY || "";
  let res;
  try {
    res = await fetch(`${base}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: {} }),
    });
  } catch (netErr) {
    return { session: null, error: netErr instanceof Error ? netErr : new Error(String(netErr)) };
  }

  let json = {};
  try {
    json = await res.json();
  } catch (_) {
    /* vacío */
  }
  if (!res.ok) {
    const msg =
      json.error_description || json.msg || json.message || json.error || `Error HTTP ${res.status}`;
    return { session: null, error: new Error(typeof msg === "string" ? msg : JSON.stringify(msg)) };
  }

  const { access_token, refresh_token } = json;
  if (!access_token || !refresh_token) {
    return {
      session: null,
      error: new Error("Supabase no devolvió tokens. Revisá Authentication → Providers → Anonymous."),
    };
  }

  let setOut;
  try {
    setOut = await Promise.race([
      supabaseClient.auth.setSession({ access_token, refresh_token }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("__setsession_timeout__")), 15000)),
    ]);
  } catch (e) {
    if (e?.message === "__setsession_timeout__") {
      return {
        session: null,
        error: new Error("Guardar la sesión en el navegador tardó demasiado. Recargá con Cmd+Shift+R."),
      };
    }
    return { session: null, error: e instanceof Error ? e : new Error(String(e)) };
  }

  if (setOut?.error) {
    return { session: null, error: setOut.error };
  }
  const session = setOut?.data?.session ?? null;
  if (session) {
    return { session, error: null };
  }
  return { session: null, error: new Error("No se pudo activar la sesión en el cliente.") };
}

const SYNC_FROM_SUPABASE_TIMEOUT_MS = 30000;

function mirrorCloudCachesToLocal() {
  writeList(KEYS.sales, cacheSales);
  writeList(KEYS.cash, cacheCash);
  writeList(KEYS.inventory, cacheInventory);
  writeList(KEYS.receivables, cacheReceivables);
  writeList(KEYS.invoices, cacheInvoices);
  writeList(KEYS.pipelineLeads, cachePipelineLeads);
  writeList(KEYS.sellers, cacheSellers);
  writeList(KEYS.deviceHistory, cacheDeviceHistory);
}

function unsubscribeCloudRealtime() {
  if (realtimeRefreshTimer != null) {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = null;
  }
  if (cloudRealtimeChannel && supabaseClient) {
    void supabaseClient.removeChannel(cloudRealtimeChannel);
    cloudRealtimeChannel = null;
  }
}

function scheduleRefreshFromRealtime() {
  if (!useCloud || !supabaseClient) return;
  if (realtimeRefreshTimer != null) clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    try {
      await refreshCloud();
      mirrorCloudCachesToLocal();
      renderAll();
      updateConnectionUI();
    } catch (e) {
      console.warn("Supabase Realtime → lectura:", e);
    }
  }, 280);
}

/** Escucha cambios en las tablas (otra pestaña, SQL, otro cliente) y vuelve a leer la base. */
function subscribeCloudRealtime() {
  unsubscribeCloudRealtime();
  if (!supabaseClient || !useCloud) return;
  const ch = supabaseClient.channel("go-apple-crm-live");
  for (const table of [
    "sales",
    "cash_movements",
    "inventory_items",
    "crm_settings",
    "pending_receivables",
    "invoices",
    "pipeline_leads",
    "salespeople",
  ]) {
    ch.on("postgres_changes", { event: "*", schema: "public", table }, () => scheduleRefreshFromRealtime());
  }
  ch.subscribe();
  cloudRealtimeChannel = ch;
}

/**
 * Con la sesión ya activa en el cliente: lee la base, activa modo nube y Realtime.
 */
async function loadCloudDataWithCurrentSession() {
  await Promise.race([
    refreshCloud(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Supabase tardó demasiado. Revisá red, tablas y RLS.")),
        SYNC_FROM_SUPABASE_TIMEOUT_MS
      )
    ),
  ]);
  await window.__businessExtras?.loadWeekClosesFromCloud?.();
  useCloud = true;
  mirrorCloudCachesToLocal();
  subscribeCloudRealtime();
}

function showAuthGate() {
  if (isStaffMode()) return;
  loginPanelVisible = true;
  const o = document.getElementById("auth-overlay");
  if (o) {
    o.hidden = false;
    o.setAttribute("aria-hidden", "false");
  }
}

function hideAuthGate() {
  loginPanelVisible = false;
  const o = document.getElementById("auth-overlay");
  if (o) {
    o.hidden = true;
    o.setAttribute("aria-hidden", "true");
  }
}

function setAuthStatus(text) {
  const el = document.getElementById("auth-status");
  if (el) el.textContent = text || "";
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  if (msg) {
    el.hidden = false;
    el.textContent = msg;
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

function prefillAuthEmail() {
  const input = document.getElementById("auth-email");
  if (!input || input.value.trim()) return;
  const e = (window.APP_SUPABASE_LOGIN_EMAIL || window.APP_SUPABASE_EMAIL || "").trim();
  if (e) input.value = e;
}

/**
 * Sesión guardada, ?email=&password= en la URL (una vez), o email/contraseña en config.js.
 */
async function tryEnterCloudFromStoredUrlOrConfig() {
  const urlCreds = readAndStripLoginFromUrl();
  const emailTry = (urlCreds.email || (window.APP_SUPABASE_EMAIL || "").trim()).trim();
  const passwordTry = urlCreds.password || getSupabasePasswordFromConfig();
  // Si hay usuario en config, entra con ese. Una sesión vieja (invitado u otra cuenta) deja el panel en cero.
  if (emailTry && passwordTry) {
    const pwOut = await signInWithPasswordFlow(emailTry, passwordTry);
    if (pwOut.session) {
      hideAuthGate();
      await loadCloudDataWithCurrentSession();
      return true;
    }
  }

  const restored = await tryRestoreStoredSession();
  if (restored.session) {
    hideAuthGate();
    await loadCloudDataWithCurrentSession();
    return true;
  }

  return false;
}

async function getUserId() {
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || !data.user) throw new Error("Sesión inválida. Cerrá sesión e iniciá de nuevo.");
  return data.user.id;
}

function toBatteryLabel(value) {
  if (value === "" || value === null || value === undefined) return "-";
  return `${value}%`;
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * KPI del resumen: monto + unidad en una sola línea visual (inline-flex en .stat-num--money).
 * \u202f = espacio fino sin salto entre cifra y US$.
 */
function setKpiMoneyText(el, value) {
  if (!el) return;
  const n = numeric(value, 0);
  const amount = new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  el.classList.add("stat-num--money");
  el.innerHTML = `<span class="stat-num-amount">${amount}</span><span class="stat-num-unit">\u202fUS$</span>`;
}

function escapeHtml(str) {
  if (str == null || str === "") return "";
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}

function formatCopyAsSlides(copyText, editable) {
  if (!copyText) return "";
  const lines = copyText.split(/\n/);
  const slideRegex = /^slide\s*(\d+)\s*:\s*/i;

  const slides = [];
  let currentSlide = null;
  let preSlideLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const m = line.match(slideRegex);
    if (m) {
      if (currentSlide) slides.push(currentSlide);
      const sameLine = line.replace(slideRegex, "").trim();
      currentSlide = { num: parseInt(m[1]), lines: sameLine ? [sameLine] : [] };
    } else if (currentSlide) {
      currentSlide.lines.push(line);
    } else {
      preSlideLines.push(line);
    }
  }
  if (currentSlide) slides.push(currentSlide);

  if (slides.length === 0) {
    const allText = preSlideLines.join("\n");
    if (editable) {
      let block = `<div class="ga-lb__slide-block"><textarea class="ga-lb__slide-edit" data-slide="general" rows="3">${escapeHtml(allText)}</textarea></div>` +
        `<div class="ga-lb__slide-actions"><button type="button" class="ga-lb__save-copy-btn" id="ga-lb-save-copy">💾 Guardar copy</button>`;
      if (isCreativosImageGenEnabled()) {
        block += `<button type="button" class="ga-lb__regen-from-copy-btn" id="ga-lb-save-regen">💾 Guardar y re-generar imágenes</button>`;
      }
      return block + `</div>`;
    }
    return preSlideLines.map(l => `<p style="margin:2px 0">${escapeHtml(l)}</p>`).join("");
  }

  let html = "";

  if (preSlideLines.length > 0) {
    const pre = preSlideLines.join("\n");
    if (editable) {
      html += `<div class="ga-lb__slide-block ga-lb__slide-block--general"><textarea class="ga-lb__slide-edit" data-slide="pre" rows="2">${escapeHtml(pre)}</textarea></div>`;
    } else {
      html += preSlideLines.map(l => `<p style="margin:2px 0">${escapeHtml(l)}</p>`).join("");
    }
  }

  for (const s of slides) {
    const text = s.lines.join("\n");
    const rows = Math.max(2, Math.min(s.lines.length + 1, 5));
    if (editable) {
      html += `<div class="ga-lb__slide-block"><span class="ga-lb__slide-label">Slide ${s.num}:</span><textarea class="ga-lb__slide-edit" data-slide="${s.num}" rows="${rows}">${escapeHtml(text)}</textarea></div>`;
    } else {
      html += `<div class="ga-lb__slide-block"><span class="ga-lb__slide-label">Slide ${s.num}:</span><br>${escapeHtml(text)}</div>`;
    }
  }

  if (editable) {
    html += `<div class="ga-lb__slide-actions"><button type="button" class="ga-lb__save-copy-btn" id="ga-lb-save-copy">💾 Guardar copy</button>`;
    if (isCreativosImageGenEnabled()) {
      html += `<button type="button" class="ga-lb__regen-from-copy-btn" id="ga-lb-save-regen">💾 Guardar y re-generar imágenes</button>`;
    }
    html += `</div>`;
  }
  return html;
}

/** Clientes únicos desde ventas (nombre + último teléfono / IG vistos en la venta más reciente). */
function getClientDirectoryFromSales() {
  const sales = getSales();
  const map = new Map();
  for (const s of sales) {
    const name = (s.client || "").trim();
    if (!name) continue;
    if (map.has(name)) continue;
    map.set(name, {
      phone: (s.phone || "").trim(),
      ig: (s.igHandle || "").trim(),
    });
  }
  return Array.from(map.entries())
    .map(([name, { phone, ig }]) => ({ name, phone, ig }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function refreshSaleClientSelect() {
  if (!saleClientSelect || !saleClient) return;
  const nameKeep = saleClient.value.trim();
  saleClientSelect.innerHTML = "";
  const optNew = document.createElement("option");
  optNew.value = "__new__";
  optNew.textContent = "Nuevo cliente…";
  saleClientSelect.appendChild(optNew);
  for (const { name, phone, ig } of getClientDirectoryFromSales()) {
    const opt = document.createElement("option");
    opt.value = name;
    const bits = [phone || null, ig ? `@${ig.replace(/^@+/, "")}` : null].filter(Boolean);
    opt.textContent = bits.length ? `${name} · ${bits.join(" · ")}` : name;
    opt.dataset.phone = phone;
    opt.dataset.ig = ig || "";
    saleClientSelect.appendChild(opt);
  }
  if (nameKeep && [...saleClientSelect.options].some((o) => o.value === nameKeep)) {
    saleClientSelect.value = nameKeep;
  } else {
    saleClientSelect.value = "__new__";
  }
}

function saleCartGrossTotal() {
  return saleCart.reduce((sum, line) => sum + numeric(line.quantity, 0) * numeric(line.unitSale, 0), 0);
}

function updateSaleCheckoutSummary() {
  const gross = saleCartGrossTotal();
  const tradeIn = saleTradeInValue ? numeric(saleTradeInValue.value, 0) : 0;
  const net = Math.max(0, gross - tradeIn);
  if (saleSummaryGross) saleSummaryGross.textContent = currency(gross);
  if (saleSummaryTrade) {
    saleSummaryTrade.textContent = tradeIn > 0 ? `−${currency(tradeIn)}` : currency(0);
  }
  if (saleSummaryNet) saleSummaryNet.textContent = currency(net);
}

function renderSaleCart() {
  if (!saleCartBody || !saleCartEmpty || !saleCartTableWrap) return;
  const has = saleCart.length > 0;
  saleCartEmpty.hidden = has;
  saleCartTableWrap.hidden = !has;
  if (saleCartClearBtn) saleCartClearBtn.hidden = !has || saleModalEditMode;
  saleCartBody.innerHTML = "";
  saleCart.forEach((line) => {
    const tr = document.createElement("tr");
    const sub = numeric(line.quantity, 0) * numeric(line.unitSale, 0);
    const devId = resolveLineDeviceIdentity(line);
    const idBit = devId.imei
      ? `IMEI ${devId.imei}`
      : devId.serial
        ? `Serie ${devId.serial}`
        : "";
    const title = `${line.model} · ${line.color} · ${line.storage}`;
    tr.innerHTML = `
      <td>
        <div class="sale-cart-cell-title">${escapeHtml(line.model)}</div>
        <div class="muted sale-cart-cell-meta">${escapeHtml(line.color)} · ${escapeHtml(line.storage)}${
          line.battery ? ` · Bat ${escapeHtml(String(line.battery))}%` : ""
        }${idBit ? ` · ${escapeHtml(idBit)}` : ""}</div>
      </td>
      <td>${escapeHtml(String(line.quantity))}</td>
      <td>${currency(numeric(line.unitSale, 0))}</td>
      <td>${currency(sub)}</td>
      <td>${
        saleModalEditMode
          ? '<span class="muted">—</span>'
          : `<button type="button" class="secondary sale-cart-remove" data-line-id="${escapeHtml(line.id)}">Quitar</button>`
      }</td>
    `;
    tr.title = title;
    saleCartBody.appendChild(tr);
  });
  updateSaleCheckoutSummary();
}

/** Reparte `total` en USD según pesos no negativos; la suma coincide con `total` (ajuste en el último ítem). */
function splitProportionalUsd(total, weights) {
  const w = weights.map((x) => Math.max(0, numeric(x, 0)));
  const sumW = w.reduce((a, b) => a + b, 0);
  const n = w.length;
  if (n === 0) return [];
  if (sumW <= 0) return w.map(() => 0);
  const cents = Math.round(total * 100);
  const parts = w.map((wi) => Math.floor((cents * wi) / sumW));
  let rem = cents - parts.reduce((a, b) => a + b, 0);
  for (let i = parts.length - 1; rem > 0 && i >= 0; i--) {
    parts[i] += 1;
    rem -= 1;
  }
  return parts.map((p) => p / 100);
}

function findInventoryRowByKeys(inventory, model, color, storage, battery) {
  let match = inventory.find(
    (i) => getInventoryKey(i.model, i.color, i.storage, i.battery) === getInventoryKey(model, color, storage, battery)
  );
  if (!match && !battery) {
    match = inventory.find(
      (i) =>
        (i.model || "").toLowerCase() === model.toLowerCase() &&
        (i.color || "").toLowerCase() === color.toLowerCase() &&
        (i.storage || "").toLowerCase() === storage.toLowerCase()
    );
  }
  return match || null;
}

/**
 * Misma lógica que al guardar una venta: inventario por id elegido o por clave.
 * `inventory` es el listado actual (puede mutar entre agregar al carrito y guardar).
 */
function resolveInventoryMatchForSaleLine(inventory, pickedId, model, color, storage, battery, quantity) {
  let match = null;
  if (pickedId) {
    const byId = inventory.find((i) => String(i.id) === pickedId);
    if (
      byId &&
      getInventoryKey(byId.model, byId.color, byId.storage, byId.battery) ===
        getInventoryKey(model, color, storage, battery)
    ) {
      match = byId;
    }
  }
  if (!match) {
    match = findInventoryRowByKeys(inventory, model, color, storage, battery);
  }

  let deductInventory = false;
  if (match && match.stock >= quantity) {
    deductInventory = true;
  } else if (match && match.stock < quantity) {
    const ok = confirm(
      `En inventario hay ${match.stock} unidad(es) y pedís ${quantity}. ¿Agregar al carrito sin descontar stock? (Venta rápida)`
    );
    if (!ok) return { cancelled: true };
  } else {
    const ok = confirm(
      "No hay fila en inventario que coincida con modelo, color, almacenamiento y batería. ¿Agregar al carrito sin descontar inventario?"
    );
    if (!ok) return { cancelled: true };
  }

  return { match, deductInventory };
}

function normalizeSale(s) {
  if (!s) return s;
  let commissionPctApplied =
    s.commissionPctApplied !== undefined && s.commissionPctApplied !== null
      ? numeric(s.commissionPctApplied, NaN)
      : s.commission_pct_applied !== undefined && s.commission_pct_applied !== null
        ? numeric(s.commission_pct_applied, NaN)
        : null;
  if (Number.isNaN(commissionPctApplied)) commissionPctApplied = null;
  return {
    ...s,
    tradeInDescription: s.tradeInDescription ?? s.trade_in_description ?? "",
    tradeInValue: numeric(s.tradeInValue ?? s.trade_in_value, 0),
    paymentCash: numeric(s.paymentCash ?? s.payment_cash, 0),
    paymentTransfer: numeric(s.paymentTransfer ?? s.payment_transfer, 0),
    paymentCard: numeric(s.paymentCard ?? s.payment_card, 0),
    paymentOther: numeric(s.paymentOther ?? s.payment_other, 0),
    payment: s.payment ?? "",
    deductFromInventory: (s.deductFromInventory ?? s.deduct_from_inventory) !== false,
    tradeInInvModel: s.tradeInInvModel ?? s.trade_in_inv_model ?? "",
    tradeInInvColor: s.tradeInInvColor ?? s.trade_in_inv_color ?? "",
    tradeInInvStorage: s.tradeInInvStorage ?? s.trade_in_inv_storage ?? "",
    tradeInInvBattery: s.tradeInInvBattery ?? s.trade_in_inv_battery ?? "",
    igHandle: (s.igHandle ?? s.ig_handle ?? "").trim(),
    sellerId: s.sellerId ?? s.seller_id ?? null,
    commissionPctApplied,
    commissionAmount: numeric(s.commissionAmount ?? s.commission_amount, 0),
    commissionPaid: Boolean(s.commissionPaid ?? s.commission_paid),
    commissionPaidAt: s.commissionPaidAt ?? s.commission_paid_at ?? null,
  };
}

function normalizeSeller(s) {
  if (!s) return s;
  return {
    id: s.id,
    name: String(s.name || "").trim(),
    commissionPct: Math.min(100, Math.max(0, numeric(s.commissionPct ?? s.commission_pct, 0))),
    active: s.active !== false,
    createdAt: s.createdAt ?? s.created_at ?? null,
  };
}

function sellerFromRow(row) {
  return normalizeSeller({
    id: row.id,
    name: row.name,
    commission_pct: row.commission_pct,
    active: row.active,
    created_at: row.created_at,
  });
}

function getSellers() {
  const list = useCloud ? cacheSellers : readList(KEYS.sellers);
  return (Array.isArray(list) ? list : []).map((x) => normalizeSeller(x));
}

/** Comisión = % del vendedor sobre el monto que entró (sale_total neto de la línea, después de canje). */
function computeSaleCommission(sellerId, saleAmount) {
  const p = Math.max(0, numeric(saleAmount, 0));
  const sid = sellerId && String(sellerId).trim() ? String(sellerId).trim() : null;
  if (!sid) {
    return { sellerId: null, commissionPctApplied: null, commissionAmount: 0 };
  }
  const sp = getSellers().find((x) => String(x.id) === String(sid));
  if (!sp) {
    return { sellerId: sid, commissionPctApplied: null, commissionAmount: 0 };
  }
  const pct = numeric(sp.commissionPct, 0);
  const amount = Math.round(p * (pct / 100) * 100) / 100;
  return { sellerId: sid, commissionPctApplied: pct, commissionAmount: amount };
}

const COMISION_VENTA_PREFIX = "COMISION_VENTA:";

function commissionCashConceptBase(saleId) {
  return `${COMISION_VENTA_PREFIX}${String(saleId)}`;
}

function commissionCashConcept(saleId, clientName) {
  const c = (clientName || "").trim().slice(0, 50);
  return `${commissionCashConceptBase(saleId)}|Comisión vendedor · ${c || "Venta"}`;
}

function removeCommissionCashRowsLocal(saleId) {
  const cash = readList(KEYS.cash);
  const base = commissionCashConceptBase(saleId);
  const next = cash.filter((row) => !String(row.concept || "").startsWith(base));
  if (next.length !== cash.length) writeList(KEYS.cash, next);
}

async function removeCommissionCashRowsCloud(userId, saleId) {
  if (!supabaseClient || !userId || !saleId) return;
  const base = commissionCashConceptBase(saleId);
  const { data: rows, error: selErr } = await supabaseClient
    .from("cash_movements")
    .select("id")
    .eq("user_id", userId)
    .like("concept", `${base}%`);
  if (selErr) throw selErr;
  for (const r of rows || []) {
    const { error } = await supabaseClient.from("cash_movements").delete().eq("id", r.id).eq("user_id", userId);
    if (error) throw error;
  }
}

/** Egreso en Caja por comisión: solo si hay vendedor y comisión > 0; si no, elimina filas vinculadas a esa venta. */
async function syncCommissionCashFromSale(userId, saleId, saleDateYmd, clientName, commissionAmount, sellerId) {
  const amount = numeric(commissionAmount, 0);
  const hasSeller = sellerId != null && String(sellerId).trim() !== "";

  if (useCloud) {
    await removeCommissionCashRowsCloud(userId, saleId);
    if (amount > 0 && hasSeller) {
      const { error } = await supabaseClient.from("cash_movements").insert({
        user_id: userId,
        movement_type: "egreso",
        movement_date: saleDateYmd,
        concept: commissionCashConcept(saleId, clientName),
        amount,
        egreso_kind: "operativo",
        reparto_dest: "reserva",
      });
      if (error) throw error;
    }
  } else {
    removeCommissionCashRowsLocal(saleId);
    if (amount > 0 && hasSeller) {
      const cash = readList(KEYS.cash);
      cash.unshift({
        id: crypto.randomUUID(),
        type: "egreso",
        date: saleDateYmd,
        concept: commissionCashConcept(saleId, clientName),
        amount,
        egresoKind: "operativo",
        repartoDest: "reserva",
      });
      writeList(KEYS.cash, cash);
    }
  }
}

function getSellerNameById(id) {
  if (!id) return "";
  const sp = getSellers().find((x) => String(x.id) === String(id));
  return sp ? sp.name : "";
}

function formatSaleSellerCell(sale) {
  const sid = sale.sellerId || sale.seller_id;
  if (!sid) return "—";
  const name = getSellerNameById(sid);
  const label = name || "Vendedor (sin datos)";
  const ca = numeric(sale.commissionAmount, 0) || computeSaleCommission(String(sid), numeric(sale.saleTotal, 0)).commissionAmount;
  if (ca > 0) {
    const paidBadge = sale.commissionPaid
      ? '<span class="comm-paid-badge">Pagada</span>'
      : '<span class="comm-unpaid-badge">Pendiente</span>';
    return `${escapeHtml(label)}<div class="muted">Com. ${currency(ca)} ${paidBadge}</div>`;
  }
  return escapeHtml(label);
}

function refreshSaleSellerSelect() {
  if (!saleSeller) return;
  const prevVal = saleSeller.value;
  const sellers = getSellers().slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let keepInactiveId = null;
  if (editingSaleId) {
    const cur = getSales().find((x) => String(x.id) === String(editingSaleId));
    keepInactiveId = cur?.sellerId || cur?.seller_id || null;
  }
  saleSeller.innerHTML = "";
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = "Sin vendedor";
  saleSeller.appendChild(o0);
  for (const sp of sellers) {
    if (!sp.active && String(sp.id) !== String(keepInactiveId)) continue;
    const o = document.createElement("option");
    o.value = String(sp.id);
    o.textContent = sp.active ? sp.name : `${sp.name} (inactivo)`;
    saleSeller.appendChild(o);
  }
  if (keepInactiveId && !sellers.some((x) => String(x.id) === String(keepInactiveId))) {
    const o = document.createElement("option");
    o.value = String(keepInactiveId);
    o.textContent = "Vendedor (ya no está en la lista)";
    saleSeller.appendChild(o);
  }
  if (editingSaleId) {
    const cur = getSales().find((x) => String(x.id) === String(editingSaleId));
    const sid = cur?.sellerId || cur?.seller_id;
    saleSeller.value = sid ? String(sid) : "";
    return;
  }
  const ok = [...saleSeller.options].some((opt) => opt.value === prevVal);
  saleSeller.value = ok ? prevVal : "";
}

function warrantyEndDateStr(saleDateYmd) {
  const [y, m, d] = String(saleDateYmd).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + WARRANTY_DAYS);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Días hasta el fin de garantía (inclusive). Negativo = ya venció. */
function warrantyDaysRemaining(saleDateYmd) {
  const endStr = warrantyEndDateStr(saleDateYmd);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const endD = new Date(ey, em - 1, ed);
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  endD.setHours(0, 0, 0, 0);
  return Math.round((endD - t) / 86400000);
}

function formatPaymentSummary(s) {
  const parts = [];
  const tv = numeric(s.tradeInValue, 0);
  if (tv > 0) {
    parts.push(`Canje ${currency(tv)}`);
    const desc = (s.tradeInDescription || "").trim();
    if (desc) {
      parts.push(`<span class="muted">${escapeHtml(desc.length > 80 ? `${desc.slice(0, 77)}…` : desc)}</span>`);
    }
  }
  if (numeric(s.paymentCash, 0) > 0) parts.push(`Efectivo ${currency(s.paymentCash)}`);
  if (numeric(s.paymentTransfer, 0) > 0) parts.push(`Transf. ${currency(s.paymentTransfer)}`);
  if (numeric(s.paymentCard, 0) > 0) parts.push(`Tarjeta ${currency(s.paymentCard)}`);
  if (numeric(s.paymentOther, 0) > 0) parts.push(`Otro ${currency(s.paymentOther)}`);
  const note = (s.payment || "").trim();
  if (note) parts.push(`<span class="muted">${escapeHtml(note.length > 60 ? `${note.slice(0, 57)}…` : note)}</span>`);
  return parts.length ? parts.join(" · ") : "—";
}

/** Valor del equipo recibido en canje (plan canje). */
function saleTradeInReceivedValue(sale) {
  return numeric(sale?.tradeInValue ?? sale?.trade_in_value, 0);
}

/** Ganancia contable (cobrado − costo); puede ser negativa con canje. */
function saleCashMargin(sale) {
  return numeric(sale?.profit, 0);
}

/** Resultado económico: margen en caja + valor del canje recibido a stock. */
function saleAdjustedProfit(sale) {
  return saleCashMargin(sale) + saleTradeInReceivedValue(sale);
}

function summarizeSalesProfit(sales) {
  let cashMargin = 0;
  let tradeInReceived = 0;
  for (const s of sales) {
    cashMargin += saleCashMargin(s);
    tradeInReceived += saleTradeInReceivedValue(s);
  }
  return {
    cashMargin,
    tradeInReceived,
    adjustedProfit: cashMargin + tradeInReceived,
  };
}

function formatSaleProfitCell(sale) {
  const cash = saleCashMargin(sale);
  const canje = saleTradeInReceivedValue(sale);
  if (canje > 0) {
    const adj = cash + canje;
    const cashClass =
      cash < -0.01 ? "sale-result-chip--cash-info" : cash > 0.01 ? "sale-result-chip--cash-pos" : "";
    return `<div class="sale-result-cell">
      <strong class="sale-result-cell__main sale-result-cell__main--pos">${currency(adj)}</strong>
      <div class="sale-result-chips">
        <span class="sale-result-chip ${cashClass}">Cobrado − costo ${currency(cash)}</span>
        <span class="sale-result-chip sale-result-chip--canje">Canje ${currency(canje)}</span>
      </div>
    </div>`;
  }
  const mainClass = cash < -0.01 ? "sale-result-cell__main--neg" : cash > 0.01 ? "sale-result-cell__main--pos" : "";
  return `<div class="sale-result-cell"><strong class="sale-result-cell__main ${mainClass}">${currency(cash)}</strong></div>`;
}

function normalizeImeiDigits(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length === 15 ? d : "";
}

const DEVICE_EVENT_LABELS = {
  ingreso: "Ingreso al inventario",
  actualizado: "Actualización en inventario",
  baja: "Baja del inventario",
  venta: "Venta a cliente",
  venta_anulada: "Venta anulada",
  devolucion_stock: "Vuelta al inventario",
  canje_ingreso: "Ingreso por canje",
  en_tecnico: "Enviado a servicio técnico",
  salida_tecnico: "Salida de servicio técnico",
};

function parseDeviceIdentity(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { serial: "", imei: "" };
  const imei = normalizeImeiDigits(trimmed);
  if (imei) return { serial: "", imei };
  return { serial: trimmed.toUpperCase(), imei: "" };
}

function resolveLineDeviceIdentity(line) {
  const serial = String(line?.serial || "").trim().toUpperCase();
  const imei = normalizeImeiDigits(line?.imei);
  if (serial || imei) return { serial, imei };
  return parseDeviceIdentity(line?.imei);
}

function resolveSaleDeviceIdentity(sale) {
  if (!sale) return { serial: "", imei: "" };
  const serial = String(sale?.serial || "").trim().toUpperCase();
  const imei = normalizeImeiDigits(sale?.imei);
  if (serial || imei) return { serial, imei };
  const raw = String(sale?.imei ?? "").trim();
  if (!raw) return { serial: "", imei: "" };
  return parseDeviceIdentity(raw);
}

function saleHasDeviceIdentity(sale) {
  const id = resolveSaleDeviceIdentity(sale);
  return Boolean(id.serial || id.imei);
}

/** Actualiza la venta en memoria/local tras editar (la nube a veces tarda en reflejarse en el modal). */
function patchCachedSaleAfterEdit(saleId, patch) {
  const id = String(saleId);
  const merge = (prev) => normalizeSale({ ...prev, ...patch, id: prev?.id || id });
  if (useCloud) {
    const idx = cacheSales.findIndex((s) => String(s.id) === id);
    if (idx >= 0) cacheSales[idx] = merge(cacheSales[idx]);
  }
  const local = readList(KEYS.sales);
  const li = local.findIndex((s) => String(s.id) === id);
  if (li >= 0) {
    local[li] = merge(local[li]);
    writeList(KEYS.sales, local);
  }
  mirrorCloudCachesToLocal();
}

function formatSaleImeiForStorage(line) {
  const id = resolveLineDeviceIdentity(line);
  return id.imei || id.serial || "";
}

function buildSaleDeviceIdentityCellHtml(sale, options = {}) {
  const showHistoryBtn = options.showHistoryBtn === true;
  const id = resolveSaleDeviceIdentity(sale);
  if (id.imei) {
    const histBtn = showHistoryBtn
      ? `<button type="button" class="secondary sale-device-id__hist warranty-history-btn" data-imei="${escapeHtml(id.imei)}" data-serial="">Historial</button>`
      : "";
    return `<div class="sale-device-id"><span class="sale-device-id__tag">IMEI</span> <code class="sale-device-id__code">${escapeHtml(id.imei)}</code>${histBtn}</div>`;
  }
  if (id.serial) {
    const histBtn = showHistoryBtn
      ? `<button type="button" class="secondary sale-device-id__hist warranty-history-btn" data-serial="${escapeHtml(id.serial)}" data-imei="">Historial</button>`
      : "";
    return `<div class="sale-device-id"><span class="sale-device-id__tag">Serie</span> <code class="sale-device-id__code">${escapeHtml(id.serial)}</code>${histBtn}</div>`;
  }
  return `<div class="sale-device-id sale-device-id--warn muted">Sin serie ni IMEI — completá en Editar venta</div>`;
}

function deviceIdentityMatchesQuery(evt, querySerial, queryImei) {
  if (querySerial && String(evt.serial || "").toUpperCase() === querySerial) return true;
  if (queryImei && String(evt.imei || "") === queryImei) return true;
  return false;
}

function parseDeviceHistoryQuery(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { serial: "", imei: "", valid: false };
  const parsed = parseDeviceIdentity(trimmed);
  return {
    serial: parsed.serial,
    imei: parsed.imei,
    valid: Boolean(parsed.serial || parsed.imei),
  };
}

function deviceHistoryFromRow(row) {
  return {
    id: row.id,
    eventType: row.event_type || row.eventType,
    serial: row.serial || "",
    imei: row.imei || "",
    inventoryItemId: row.inventory_item_id || row.inventoryItemId || null,
    saleId: row.sale_id || row.saleId || null,
    clientName: row.client_name || row.clientName || "",
    model: row.model || "",
    color: row.color || "",
    storage: row.storage || "",
    battery: row.battery ?? "",
    detail: row.detail || "",
    eventAt: row.event_at || row.eventAt || row.created_at,
    source: row.source || "log",
  };
}

function deviceHistoryDedupeKey(evt) {
  return [
    evt.eventType,
    evt.eventAt || "",
    evt.saleId || "",
    evt.inventoryItemId || "",
    evt.detail || "",
    evt.clientName || "",
    evt.model || "",
  ].join("|");
}

function mergeDeviceHistoryEvents(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const evt of list) {
      const key = deviceHistoryDedupeKey(evt);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(evt);
    }
  }
  out.sort((a, b) => String(b.eventAt || "").localeCompare(String(a.eventAt || "")));
  return out;
}

function saleEventAtIso(saleDateYmd, hourUtc = 12) {
  const dateStr = String(saleDateYmd || "").trim();
  if (!dateStr) return new Date().toISOString();
  const h = String(hourUtc).padStart(2, "0");
  return `${dateStr}T${h}:00:00.000Z`;
}

/** Ingreso al inventario inferido para una venta (fila borrada al vender o sin serie al ingresar). */
function inferIngressLegacyEventForSale(sale, devId) {
  if (sale.deductFromInventory === false) return null;

  const byUnit = findInventoryItemByDeviceIdentity(devId.serial, devId.imei);
  if (byUnit?.createdAt) {
    const saleAt = new Date(saleEventAtIso(sale.date, 12));
    const ingAt = new Date(byUnit.createdAt);
    if (!Number.isNaN(saleAt.getTime()) && !Number.isNaN(ingAt.getTime()) && ingAt <= saleAt) {
      return {
        id: `legacy-ingress-unit-${byUnit.id}`,
        eventType: "ingreso",
        serial: devId.serial,
        imei: devId.imei,
        inventoryItemId: byUnit.id,
        model: byUnit.model || sale.model || "",
        color: byUnit.color || sale.color || "",
        storage: byUnit.storage || sale.storage || "",
        battery: byUnit.battery ?? sale.battery ?? "",
        detail: "Ingreso al inventario (misma unidad)",
        eventAt: byUnit.createdAt,
        source: "legacy",
      };
    }
  }

  const saleKey = getInventoryKey(sale.model, sale.color, sale.storage, sale.battery);
  const saleAt = new Date(saleEventAtIso(sale.date, 12));
  let best = null;
  for (const item of getInventory()) {
    if (getInventoryKey(item.model, item.color, item.storage, item.battery) !== saleKey) continue;
    const itemSer = resolveInventorySerial(item);
    const itemIm = resolveInventoryImei(item);
    if (devId.serial && itemSer && itemSer !== devId.serial) continue;
    if (devId.imei && itemIm && itemIm !== devId.imei) continue;
    if (!item.createdAt) continue;
    const ingAt = new Date(item.createdAt);
    if (!Number.isNaN(saleAt.getTime()) && ingAt > saleAt) continue;
    if (!best || String(item.createdAt) < String(best.createdAt)) best = item;
  }
  if (best) {
    return {
      id: `legacy-ingress-key-${best.id}`,
      eventType: "ingreso",
      serial: devId.serial,
      imei: devId.imei,
      inventoryItemId: best.id,
      model: best.model || sale.model || "",
      color: best.color || sale.color || "",
      storage: best.storage || sale.storage || "",
      battery: best.battery ?? sale.battery ?? "",
      detail: "Ingreso al inventario (mismo modelo/color/stock)",
      eventAt: best.createdAt,
      source: "legacy",
    };
  }

  if (String(sale.date || "").trim()) {
    const est = new Date(saleEventAtIso(sale.date, 10));
    est.setUTCDate(est.getUTCDate() - 1);
    return {
      id: `legacy-ingress-est-${sale.id}`,
      eventType: "ingreso",
      serial: devId.serial,
      imei: devId.imei,
      inventoryItemId: null,
      model: sale.model || "",
      color: sale.color || "",
      storage: sale.storage || "",
      battery: sale.battery ?? "",
      detail: "En stock antes de la venta (fecha estimada)",
      eventAt: est.toISOString(),
      source: "legacy",
    };
  }
  return null;
}

/** Eventos guardados sin serie/IMEI pero ligados a una venta que ahora sí tiene identificador. */
function collectLoggedHistoryRelinkedBySale(querySerial, queryImei) {
  const out = [];
  for (const sale of getSales()) {
    const id = resolveSaleDeviceIdentity(sale);
    if (!deviceIdentityMatchesQuery(id, querySerial, queryImei)) continue;
    for (const e of getDeviceHistoryList()) {
      if (String(e.saleId || "") !== String(sale.id)) continue;
      if (deviceIdentityMatchesQuery(e, querySerial, queryImei)) continue;
      out.push({
        ...e,
        serial: id.serial || e.serial,
        imei: id.imei || e.imei,
        source: "relinked",
      });
    }
  }
  return out;
}

function rebuildDeviceHistoryFromLegacyData(querySerial, queryImei) {
  const events = [];
  for (const s of getSales()) {
    const id = resolveSaleDeviceIdentity(s);
    if (!deviceIdentityMatchesQuery(id, querySerial, queryImei)) continue;
    const ingress = inferIngressLegacyEventForSale(s, id);
    if (ingress) events.push(ingress);
    const eventAt = saleEventAtIso(s.date);
    events.push({
      id: `legacy-sale-${s.id}`,
      eventType: "venta",
      serial: id.serial,
      imei: id.imei,
      saleId: s.id,
      clientName: s.client || "",
      model: s.model || "",
      color: s.color || "",
      storage: s.storage || "",
      battery: s.battery ?? "",
      detail: s.deductFromInventory === false ? "Sin descuento de stock" : "Registro histórico (venta)",
      eventAt,
      source: "legacy",
    });
  }
  for (const item of getInventory()) {
    const serial = resolveInventorySerial(item);
    const imei = resolveInventoryImei(item);
    if (!deviceIdentityMatchesQuery({ serial, imei }, querySerial, queryImei)) continue;
    if (item.createdAt) {
      events.push({
        id: `legacy-inv-${item.id}`,
        eventType: "ingreso",
        serial,
        imei,
        inventoryItemId: item.id,
        model: item.model || "",
        color: item.color || "",
        storage: item.storage || "",
        battery: item.battery ?? "",
        detail: "Equipo actualmente en stock",
        eventAt: item.createdAt,
        source: "legacy",
      });
    }
  }
  return events;
}

/** Al cargar serie/IMEI después, deja rastro en el log (la línea de tiempo también reconstruye ventas viejas). */
async function backfillDeviceHistoryAfterSaleIdentityUpdate(sale, prevId) {
  const newId = resolveSaleDeviceIdentity(sale);
  if (!newId.serial && !newId.imei) return;
  const hadId = Boolean(prevId?.serial || prevId?.imei);
  if (hadId && prevId.serial === newId.serial && prevId.imei === newId.imei) return;

  const ingress = inferIngressLegacyEventForSale(sale, newId);
  if (ingress && !hadId) {
    void logDeviceHistoryEvent({
      eventType: ingress.eventType,
      serial: newId.serial,
      imei: newId.imei,
      inventoryItemId: ingress.inventoryItemId,
      model: ingress.model,
      color: ingress.color,
      storage: ingress.storage,
      battery: ingress.battery,
      detail: ingress.detail,
      eventAt: ingress.eventAt,
    });
  }

  void logDeviceHistoryEvent({
    eventType: "actualizado",
    serial: newId.serial,
    imei: newId.imei,
    saleId: sale.id,
    clientName: sale.client || "",
    model: sale.model || "",
    color: sale.color || "",
    storage: sale.storage || "",
    battery: sale.battery ?? "",
    detail: hadId
      ? "Identificador de unidad actualizado en la venta"
      : "Serie/IMEI asociado a venta registrada sin identificador (historial reconstruido)",
    eventAt: new Date().toISOString(),
  });
}

function getDeviceHistoryList() {
  if (useCloud && cacheDeviceHistory.length) return cacheDeviceHistory;
  return readList(KEYS.deviceHistory).map((x) =>
    deviceHistoryFromRow({
      ...x,
      event_type: x.eventType,
      event_at: x.eventAt,
    })
  );
}

function collectDeviceHistoryForQuery(querySerial, queryImei) {
  const logged = getDeviceHistoryList().filter((e) =>
    deviceIdentityMatchesQuery(e, querySerial, queryImei)
  );
  const relinked = collectLoggedHistoryRelinkedBySale(querySerial, queryImei);
  const legacy = rebuildDeviceHistoryFromLegacyData(querySerial, queryImei);
  return mergeDeviceHistoryEvents([logged, relinked, legacy]);
}

async function logDeviceHistoryEvent(opts) {
  const serial = String(opts.serial || "").trim().toUpperCase();
  const imei = normalizeImeiDigits(opts.imei);
  if (!serial && !imei) return;

  const row = {
    id: opts.id || crypto.randomUUID(),
    eventType: opts.eventType,
    serial,
    imei,
    inventoryItemId: opts.inventoryItemId || null,
    saleId: opts.saleId || null,
    clientName: String(opts.clientName || "").trim(),
    model: String(opts.model || "").trim(),
    color: String(opts.color || "").trim(),
    storage: String(opts.storage || "").trim(),
    battery: String(opts.battery ?? "").trim(),
    detail: String(opts.detail || "").trim(),
    eventAt: opts.eventAt || new Date().toISOString(),
    source: "log",
  };

  const local = readList(KEYS.deviceHistory);
  local.unshift(row);
  writeList(KEYS.deviceHistory, local.slice(0, 8000));
  if (!useCloud) {
    cacheDeviceHistory = local.map((x) =>
      deviceHistoryFromRow({ ...x, event_type: x.eventType, event_at: x.eventAt })
    );
  }

  if (!useCloud || !supabaseClient) return;

  try {
    const userId = await getUserId();
    const { error } = await supabaseClient.from("device_unit_history").insert({
      user_id: userId,
      event_type: row.eventType,
      serial: row.serial,
      imei: row.imei,
      inventory_item_id: row.inventoryItemId,
      sale_id: row.saleId,
      client_name: row.clientName,
      model: row.model,
      color: row.color,
      storage: row.storage,
      battery: row.battery,
      detail: row.detail,
      event_at: row.eventAt,
    });
    if (error) {
      const msg = error.message || "";
      if (/relation|does not exist|schema cache|not find.*device_unit_history/i.test(msg)) {
        console.warn(
          "Historial por serie/IMEI: ejecutá CRM/supabase/migration_device_unit_history.sql en Supabase."
        );
      } else {
        console.warn("Historial no guardado en nube:", error);
      }
      return;
    }
    cacheDeviceHistory.unshift(
      deviceHistoryFromRow({
        id: row.id,
        event_type: row.eventType,
        serial: row.serial,
        imei: row.imei,
        inventory_item_id: row.inventoryItemId,
        sale_id: row.saleId,
        client_name: row.clientName,
        model: row.model,
        color: row.color,
        storage: row.storage,
        battery: row.battery,
        detail: row.detail,
        event_at: row.eventAt,
        source: "log",
      })
    );
  } catch (e) {
    console.warn("Historial no guardado en nube:", e);
  }
}

function formatDeviceHistoryWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildDeviceHistoryEventBody(evt) {
  const parts = [];
  const modelLine = [evt.model, evt.color, evt.storage].filter(Boolean).join(" · ");
  if (modelLine) parts.push(modelLine);
  if (evt.clientName) parts.push(`Cliente: ${evt.clientName}`);
  if (evt.detail) parts.push(evt.detail);
  const ids = [];
  if (evt.serial) ids.push(`Serie ${evt.serial}`);
  if (evt.imei) ids.push(`IMEI ${evt.imei}`);
  if (ids.length) parts.push(ids.join(" · "));
  return parts.length ? parts.join(" — ") : "—";
}

function renderDeviceHistoryResults(queryRaw) {
  const q = parseDeviceHistoryQuery(queryRaw);
  if (deviceHistorySummary) deviceHistorySummary.hidden = true;
  if (deviceHistoryTimeline) deviceHistoryTimeline.hidden = true;
  if (deviceHistoryEmpty) deviceHistoryEmpty.hidden = true;

  if (!q.valid) {
    if (deviceHistoryEmpty) {
      deviceHistoryEmpty.hidden = false;
      deviceHistoryEmpty.textContent = "Ingresá un número de serie o un IMEI de 15 dígitos.";
    }
    return;
  }

  const events = collectDeviceHistoryForQuery(q.serial, q.imei);
  const idLabel = q.imei ? `IMEI ${q.imei}` : `Serie ${q.serial}`;
  const inStock = getInventory().some((item) => {
    const ser = resolveInventorySerial(item);
    const im = resolveInventoryImei(item);
    return deviceIdentityMatchesQuery({ serial: ser, imei: im }, q.serial, q.imei);
  });

  if (deviceHistorySummary) {
    deviceHistorySummary.hidden = false;
    deviceHistorySummary.innerHTML = `<strong>${escapeHtml(idLabel)}</strong> · ${events.length} movimiento(s)${
      inStock ? " · <span>Actualmente en inventario</span>" : ""
    }`;
  }

  if (!events.length) {
    if (deviceHistoryEmpty) deviceHistoryEmpty.hidden = false;
    return;
  }

  if (!deviceHistoryTimeline) return;
  deviceHistoryTimeline.hidden = false;
  deviceHistoryTimeline.innerHTML = "";
  events.forEach((evt) => {
    const li = document.createElement("li");
    li.className = `device-history-timeline__item device-history-timeline__item--${escapeHtml(evt.eventType || "otro")}`;
    const label = DEVICE_EVENT_LABELS[evt.eventType] || evt.eventType || "Movimiento";
    const tag =
      evt.source === "legacy"
        ? '<span class="device-history-timeline__tag">histórico</span>'
        : "";
    li.innerHTML = `
      <div class="device-history-timeline__head">
        <span class="device-history-timeline__type">${escapeHtml(label)}${tag}</span>
        <time class="device-history-timeline__when">${escapeHtml(formatDeviceHistoryWhen(evt.eventAt))}</time>
      </div>
      <p class="device-history-timeline__body">${escapeHtml(buildDeviceHistoryEventBody(evt))}</p>`;
    deviceHistoryTimeline.appendChild(li);
  });
}

function resetDeviceHistoryModalView() {
  if (deviceHistorySummary) deviceHistorySummary.hidden = true;
  if (deviceHistoryTimeline) {
    deviceHistoryTimeline.hidden = true;
    deviceHistoryTimeline.innerHTML = "";
  }
  if (deviceHistoryEmpty) deviceHistoryEmpty.hidden = true;
}

function openDeviceHistoryModal(prefill) {
  if (isStaffMode()) return;
  if (!deviceHistoryModal) return;
  resetDeviceHistoryModalView();
  if (deviceHistoryQuery) deviceHistoryQuery.value = String(prefill || "").trim();
  deviceHistoryModal.hidden = false;
  deviceHistoryModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
  deviceHistoryQuery?.focus();
  if (prefill) renderDeviceHistoryResults(prefill);
}

function hideDeviceHistoryModal() {
  if (!deviceHistoryModal) return;
  deviceHistoryModal.hidden = true;
  deviceHistoryModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sale-modal-open");
  resetDeviceHistoryModalView();
  if (deviceHistoryQuery) deviceHistoryQuery.value = "";
}

function openDeviceHistoryForIdentity(serial, imei) {
  const q = imei || serial || "";
  if (!q) return;
  openDeviceHistoryModal(q);
}

function resolveInventorySerial(item) {
  const s = String(item?.serial || "").trim();
  if (s) return s.toUpperCase();
  const legacy = String(item?.imei || "").trim();
  if (legacy && !normalizeImeiDigits(legacy)) return legacy.toUpperCase();
  return "";
}

function resolveInventoryImei(item) {
  const fromField = normalizeImeiDigits(item?.imei);
  if (fromField) return fromField;
  return "";
}

function getInventoryKey(model, color, storage, battery, serial, imei) {
  const unit =
    String(serial ?? "")
      .trim()
      .toLowerCase() ||
    normalizeImeiDigits(imei) ||
    String(imei ?? "")
      .trim()
      .toLowerCase();
  return `${model.trim().toLowerCase()}__${color.trim().toLowerCase()}__${storage
    .trim()
    .toLowerCase()}__${String(battery || "").trim().toLowerCase()}__${unit}`;
}

function extractImeiFromReportBlock(block) {
  const labels = ["IMEI", "IMEI1", "IMEI 1", "IMEI2", "IMEI 2"];
  for (const label of labels) {
    const line = extractReportLineField(block, label);
    const digits = normalizeImeiDigits(line);
    if (digits) return digits;
  }
  const inline = extractReportInlineField(block, "IMEI");
  const fromInline = normalizeImeiDigits(inline);
  if (fromInline) return fromInline;
  const patterns = [
    /\bIMEI\s*(?:1|2)?\s*[:\s]*(\d{15})\b/i,
    /IMEI[^0-9]{0,24}(\d{15})/i,
    /\bMEID\s*[:\s]*(\d{15})\b/i,
  ];
  for (const re of patterns) {
    const m = String(block || "").match(re);
    if (m) return m[1];
  }
  return "";
}

/** Primera columna de una línea de reporte tipo 3uTools / iDevice (tabs o espacios). */
function extractReportLineField(block, label) {
  const lines = String(block || "").split(/\r?\n/);
  const prefix = label.toLowerCase();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) continue;
    let rest = trimmed.slice(label.length).trim();
    if (rest.startsWith(":")) rest = rest.slice(1).trim();
    if (!rest) continue;
    const tabParts = rest.split(/\t+/).map((c) => c.trim()).filter(Boolean);
    if (tabParts.length) return tabParts[0];
    const cols = rest.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length) return cols[0];
    return rest;
  }
  return "";
}

function extractReportFieldFromBlock(block, labels) {
  for (const label of labels) {
    const v = extractReportLineField(block, label);
    if (v && !/^unknown$/i.test(v) && !/^n\/a$/i.test(v)) return v;
  }
  return "";
}

function extractReportFieldRegex(block, pattern) {
  const m = String(block || "").match(pattern);
  return m && m[1] ? String(m[1]).trim() : "";
}

/** Campo en la misma línea que otros (pie del reporte). */
function extractReportInlineField(block, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}\\s+([^\\n]+?)(?=\\s{4,}|$)`, "i");
  const m = String(block || "").match(re);
  if (!m) return "";
  let v = m[1].trim();
  const next = v.match(/^(.+?)\s{3,}/);
  return (next ? next[1] : v).trim();
}

function normalizeStorageCapacity(raw) {
  const m = String(raw || "").match(/(\d+)\s*GB/i);
  if (m) return `${m[1]}GB`;
  const first = String(raw || "")
    .trim()
    .split(/\s{2,}/)[0]
    ?.trim();
  return first || "";
}

function normalizeDeviceColor(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/，/g, ",").replace(/\bFront\s*/gi, "").replace(/\bRear\s*/gi, "");
  const parts = s.split(/[,/]/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : s;
}

function splitDiagnosticReports(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw.split(/(?=Device Model\s+)/i).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [raw];
}

function parseDeviceDiagnosticReport(text) {
  const block = String(text || "").trim();
  if (!block) return { valid: false, errors: ["Reporte vacío"] };

  const model =
    extractReportFieldFromBlock(block, ["Device Model", "Model", "Product Type"]) ||
    extractReportFieldRegex(block, /Device\s+Model\s*[\t:]\s*([^\n\r]+)/i);
  const colorRaw =
    extractReportFieldFromBlock(block, ["Device Color", "Device Colour", "Color", "Colour"]) ||
    extractReportFieldRegex(block, /(?:Device\s+)?Colou?r\s*[\t:]\s*([^\n\r]+)/i);
  const color = normalizeDeviceColor(colorRaw) || colorRaw.trim() || "Sin color";
  const storageRaw =
    extractReportFieldFromBlock(block, [
      "Hard Disk Capacity",
      "Disk Capacity",
      "Storage Capacity",
      "Capacity",
    ]) || extractReportFieldRegex(block, /(?:Hard\s+Disk|Disk)\s+Capacity\s*[\t:]\s*([^\n\r]+)/i);
  const storage = normalizeStorageCapacity(storageRaw) || storageRaw.trim() || "Sin almacenamiento";

  const batInline = extractReportInlineField(block, "Battery Life");
  const batM = (batInline || block).match(/(\d{1,3})\s*%/);
  const battery = batM ? String(Math.min(100, Math.max(0, parseInt(batM[1], 10)))) : "";

  const serial = extractReportLineField(block, "Serial Number").trim().toUpperCase();
  const imei = extractImeiFromReportBlock(block);

  const noteParts = [];
  const addNote = (label, val) => {
    const v = String(val || "").trim();
    if (!v || /^unknown$/i.test(v) || /^n\/a$/i.test(v)) return;
    noteParts.push(`${label}: ${v}`);
  };
  addNote("SKU", extractReportLineField(block, "Sales Model"));
  addNote("Región", extractReportLineField(block, "Sales Area"));
  addNote("Nº modelo", extractReportLineField(block, "Model Number"));
  addNote("iOS", extractReportInlineField(block, "iOS Version"));
  addNote("Activado", extractReportInlineField(block, "Activated"));
  addNote("iCloud", extractReportInlineField(block, "Apple ID Lock"));
  const cycles = extractReportInlineField(block, "Charge Times").replace(/\s*Times?\s*$/i, "");
  addNote("Ciclos carga", cycles);
  addNote("Operador", extractReportInlineField(block, "Carrier Status"));

  const errors = [];
  const warnings = [];
  if (!model) errors.push("Falta modelo (Device Model)");
  if (!serial) errors.push("Falta número de serie (Serial Number)");
  if (!colorRaw || color === "Sin color") warnings.push("Color no detectado (revisá Device Color en el reporte)");
  if (!imei) warnings.push("IMEI no detectado (podés completarlo después)");

  return {
    model: model || "",
    color,
    storage,
    battery,
    serial,
    imei,
    notes: noteParts.join(" · "),
    errors,
    warnings,
    valid: errors.length === 0 && !!model && !!serial,
  };
}

let invBulkPreviewRows = [];

function getTradeInInventoryFieldsFromSale(s) {
  const m = (s.tradeInInvModel ?? s.trade_in_inv_model ?? "").trim();
  const c = (s.tradeInInvColor ?? s.trade_in_inv_color ?? "").trim();
  const st = (s.tradeInInvStorage ?? s.trade_in_inv_storage ?? "").trim();
  const bat = String(s.tradeInInvBattery ?? s.trade_in_inv_battery ?? "").trim();
  return { m, c, st, bat };
}

function saleRecordedTradeInToInventory(s) {
  const { m, c, st } = getTradeInInventoryFieldsFromSale(s);
  return Boolean(m && c && st);
}

async function cloudApplySoldInventoryDeduction(userId, match, quantity) {
  const newStock = match.stock - quantity;
  if (newStock <= 0) {
    const { error } = await supabaseClient
      .from("inventory_items")
      .delete()
      .eq("id", match.id)
      .eq("user_id", userId);
    if (error) throw error;
  } else {
    const { error } = await supabaseClient
      .from("inventory_items")
      .update({ stock: newStock, updated_at: new Date().toISOString() })
      .eq("id", match.id)
      .eq("user_id", userId);
    if (error) throw error;
  }
}

async function cloudAddTradeInInventoryUnit(userId, tiModel, tiColor, tiStorage, tiBatteryRaw, listPrice, costValue) {
  const battery = tiBatteryRaw === "" || tiBatteryRaw == null ? "" : String(tiBatteryRaw);
  const inventory = getInventory();
  const key = getInventoryKey(tiModel, tiColor, tiStorage, battery);
  const found = inventory.find(
    (item) => getInventoryKey(item.model, item.color, item.storage, item.battery) === key
  );
  const arsFld = computeInventoryArsFields(listPrice);
  if (found) {
    const { error } = await supabaseClient
      .from("inventory_items")
      .update({
        stock: found.stock + 1,
        price: listPrice,
        cost: costValue,
        ...arsFld,
        updated_at: new Date().toISOString(),
      })
      .eq("id", found.id)
      .eq("user_id", userId);
    if (error) throw error;
  } else {
    const { error } = await supabaseClient.from("inventory_items").insert({
      user_id: userId,
      model: tiModel,
      color: tiColor,
      storage: tiStorage,
      battery,
      stock: 1,
      price: listPrice,
      cost: costValue,
      ...arsFld,
    });
    if (error) throw error;
  }
}

async function cloudReverseTradeInInventory(userId, sale) {
  if (!saleRecordedTradeInToInventory(sale)) return;
  const { m, c, st, bat } = getTradeInInventoryFieldsFromSale(sale);
  const battery = bat || "";
  const inv = getInventory();
  const key = getInventoryKey(m, c, st, battery);
  const found = inv.find(
    (item) => getInventoryKey(item.model, item.color, item.storage, item.battery) === key
  );
  if (!found || found.stock < 1) return;
  const next = found.stock - 1;
  if (next <= 0) {
    const { error } = await supabaseClient
      .from("inventory_items")
      .delete()
      .eq("id", found.id)
      .eq("user_id", userId);
    if (error) throw error;
  } else {
    const { error } = await supabaseClient
      .from("inventory_items")
      .update({ stock: next, updated_at: new Date().toISOString() })
      .eq("id", found.id)
      .eq("user_id", userId);
    if (error) throw error;
  }
}

function localApplySoldInventoryDeduction(inventory, match, quantity) {
  const newStock = match.stock - quantity;
  if (newStock <= 0) {
    const idx = inventory.findIndex((i) => i.id === match.id);
    if (idx >= 0) inventory.splice(idx, 1);
  } else {
    match.stock = newStock;
  }
}

function localAddTradeInInventoryUnit(inventory, tiModel, tiColor, tiStorage, tiBatteryRaw, listPrice, costValue) {
  const battery = tiBatteryRaw === "" || tiBatteryRaw == null ? "" : String(tiBatteryRaw);
  const key = getInventoryKey(tiModel, tiColor, tiStorage, battery);
  const found = inventory.find(
    (item) => getInventoryKey(item.model, item.color, item.storage, item.battery) === key
  );
  const ars = localArsCamelFromUsd(listPrice);
  if (found) {
    found.stock += 1;
    found.price = listPrice;
    found.cost = costValue;
    Object.assign(found, ars);
  } else {
    inventory.push({
      id: crypto.randomUUID(),
      model: tiModel,
      color: tiColor,
      storage: tiStorage,
      battery,
      stock: 1,
      price: listPrice,
      cost: costValue,
      ...ars,
    });
  }
}

function localReverseTradeInInventory(inventory, sale) {
  if (!saleRecordedTradeInToInventory(sale)) return;
  const { m, c, st, bat } = getTradeInInventoryFieldsFromSale(sale);
  const battery = bat || "";
  const key = getInventoryKey(m, c, st, battery);
  const idx = inventory.findIndex(
    (item) => getInventoryKey(item.model, item.color, item.storage, item.battery) === key
  );
  if (idx < 0) return;
  const found = inventory[idx];
  if (found.stock < 1) return;
  const next = found.stock - 1;
  if (next <= 0) {
    inventory.splice(idx, 1);
  } else {
    found.stock = next;
  }
}

function saleFromRow(row) {
  return normalizeSale({
    id: row.id,
    date: row.sale_date,
    client: row.client_name,
    phone: row.phone || "",
    model: row.model,
    color: row.color,
    storage: row.storage,
    battery: row.battery,
    imei: row.imei,
    quantity: row.quantity,
    unitSale: Number(row.unit_sale),
    unitCost: Number(row.unit_cost),
    payment: row.payment ?? "",
    tradeInDescription: row.trade_in_description ?? "",
    tradeInValue: Number(row.trade_in_value ?? 0),
    paymentCash: Number(row.payment_cash ?? 0),
    paymentTransfer: Number(row.payment_transfer ?? 0),
    paymentCard: Number(row.payment_card ?? 0),
    paymentOther: Number(row.payment_other ?? 0),
    saleTotal: Number(row.sale_total),
    costTotal: Number(row.cost_total),
    profit: Number(row.profit),
    deduct_from_inventory: row.deduct_from_inventory,
    trade_in_inv_model: row.trade_in_inv_model,
    trade_in_inv_color: row.trade_in_inv_color,
    trade_in_inv_storage: row.trade_in_inv_storage,
    trade_in_inv_battery: row.trade_in_inv_battery,
    igHandle: row.ig_handle ?? "",
    seller_id: row.seller_id ?? null,
    commission_pct_applied: row.commission_pct_applied,
    commission_amount: row.commission_amount,
    commission_paid: row.commission_paid,
    commission_paid_at: row.commission_paid_at,
  });
}

function splitCashTotalMark(concept) {
  const text = String(concept || "");
  if (text.startsWith(CASH_TOTAL_MARK)) {
    return { total: true, concept: text.slice(CASH_TOTAL_MARK.length) };
  }
  return { total: false, concept: text };
}

function conceptWithCashTotalMark(concept, dest) {
  const clean = splitCashTotalMark(concept).concept.trim();
  return dest === "total" ? `${CASH_TOTAL_MARK}${clean}` : clean;
}

function cashFromRow(row) {
  const type = row.movement_type;
  const peeled = splitCashTotalMark(row.concept);
  let repartoDest = normalizeStoredRepartoDest(
    type,
    row.reparto_dest,
    type === "egreso" ? row.egreso_kind : null
  );
  if (type === "egreso" && peeled.total) repartoDest = "total";
  const egresoKind =
    type === "egreso"
      ? repartoDestToEgresoKind(repartoDest)
      : undefined;
  return {
    id: row.id,
    type,
    date: row.movement_date,
    concept: peeled.concept,
    amount: Number(row.amount),
    repartoDest,
    ...(egresoKind ? { egresoKind } : {}),
  };
}

const CASH_INGRESO_DEST_OPTIONS = [
  { value: "reparto", label: "Reparto general (Reserva + Restock + Socios según %)" },
  { value: "reserva", label: "Solo Reserva" },
  { value: "restock", label: "Solo Restock" },
  { value: "socios", label: "Solo Socios" },
];

const CASH_TOTAL_MARK = "[[total]] ";

const CASH_EGRESO_DEST_OPTIONS = [
  { value: "reserva", label: "Reserva (gasto operativo)" },
  { value: "restock", label: "Restock (compra de equipos)" },
  { value: "socios", label: "Socios (retiro o pago)" },
  { value: "tecnico", label: "Técnico (servicio técnico)" },
  { value: "total", label: "Total (se descuenta de todo)" },
];

function normalizeStoredRepartoDest(type, repartoDest, egresoKind) {
  const raw = String(repartoDest || "").trim();
  if (type === "ingreso") {
    if (["reparto", "reserva", "restock", "socios"].includes(raw)) return raw;
    return "reparto";
  }
  if (["reserva", "restock", "socios", "tecnico", "total"].includes(raw)) return raw;
  const k = String(egresoKind || "operativo").trim();
  if (k === "restock") return "restock";
  if (k === "tecnico") return "tecnico";
  return "reserva";
}

function repartoDestToEgresoKind(dest) {
  if (dest === "restock") return "restock";
  if (dest === "tecnico") return "tecnico";
  return "operativo";
}

function cashRepartoDestOf(item) {
  if (!item) return "reparto";
  if (item.repartoDest || item.reparto_dest) {
    return normalizeStoredRepartoDest(
      item.type,
      item.repartoDest ?? item.reparto_dest,
      item.egresoKind ?? item.egreso_kind
    );
  }
  if (item.type === "egreso") {
    return normalizeStoredRepartoDest("egreso", null, item.egresoKind ?? item.egreso_kind);
  }
  if (isCommissionCashMovement(item)) return "reserva";
  return "reparto";
}

function repartoDestLabelForItem(item) {
  if (item?.isSale) return "Reparto general";
  const dest = cashRepartoDestOf(item);
  const found = [...CASH_INGRESO_DEST_OPTIONS, ...CASH_EGRESO_DEST_OPTIONS].find((o) => o.value === dest);
  return found ? found.label.split(" (")[0] : dest;
}

function populateCashRepartoDestSelect(movementType, selectedValue, targetSelectEl) {
  const sel = targetSelectEl || cashRepartoDest;
  if (!sel) return;
  const isEgreso = movementType === "egreso";
  const options = isEgreso ? CASH_EGRESO_DEST_OPTIONS : CASH_INGRESO_DEST_OPTIONS;
  const defaultValue = isEgreso ? "reserva" : "reparto";
  sel.innerHTML = "";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  const ok = options.some((o) => o.value === selectedValue);
  sel.value = ok ? selectedValue : defaultValue;
  if (!targetSelectEl && cashRepartoDestHint) {
    cashRepartoDestHint.textContent = isEgreso
      ? "El egreso se descuenta del bucket elegido. Total lo reparte entre Reserva, Restock y Socios. Técnico descuenta de Reserva."
      : "Reparto general suma a la base y se divide según los % de Metas; los demás van directo al bucket.";
  }
}

function syncCashRepartoDestUi(preferredDest) {
  const movementType = cashType?.value === "egreso" ? "egreso" : "ingreso";
  const current = preferredDest || cashRepartoDest?.value || (movementType === "egreso" ? "reserva" : "reparto");
  populateCashRepartoDestSelect(movementType, current);
}

const INV_CATEGORY_LABELS = { usado: "Usado", nuevo: "Nuevo", repuesto: "Repuesto" };

function normalizeInvCategory(raw) {
  const c = String(raw || "usado").trim().toLowerCase();
  return c === "nuevo" || c === "repuesto" ? c : "usado";
}

function invMetaFromPrice(price) {
  const p = numeric(price, 0);
  return {
    category: "usado",
    flagTecnico: false,
    flagOnline: true,
    flagVendible: p > 0,
  };
}

function invMetaFieldsForSave({ category, flagTecnico, flagOnline, flagVendible, price }) {
  const p = numeric(price, 0);
  const cat = normalizeInvCategory(category);
  const enTecnico = flagTecnico === true;
  return {
    category: cat,
    flag_tecnico: enTecnico,
    flag_online: flagOnline !== false,
    flag_vendible: enTecnico ? false : flagVendible === false ? false : flagVendible === true ? true : p > 0,
  };
}

function invMetaCamelFromRow(row) {
  const price = Number(row?.price ?? 0);
  const def = invMetaFromPrice(price);
  return {
    category: normalizeInvCategory(row?.category ?? def.category),
    flagTecnico: row?.flag_tecnico === true,
    flagOnline: row?.flag_online !== false,
    flagVendible:
      row?.flag_vendible === false ? false : row?.flag_vendible === true ? true : price > 0,
  };
}

function invFromRow(row) {
  const meta = invMetaCamelFromRow(row);
  return {
    id: row.id,
    model: row.model,
    color: row.color,
    storage: row.storage,
    battery: row.battery,
    serial: row.serial || "",
    imei: row.imei || "",
    notes: row.notes || "",
    techCostUsd: row.tech_cost_usd != null ? Number(row.tech_cost_usd) : 0,
    techNotes: row.tech_notes || "",
    techInAt: row.tech_in_at || null,
    createdAt: row.created_at || row.updated_at || null,
    updatedAt: row.updated_at || null,
    ...meta,
    stock: row.stock,
    price: Number(row.price),
    cost: Number(row.cost),
    priceArs: row.price_ars != null ? Number(row.price_ars) : 0,
    cuota3Ars: row.cuota_3_ars != null ? Number(row.cuota_3_ars) : 0,
    cuota6Ars: row.cuota_6_ars != null ? Number(row.cuota_6_ars) : 0,
    cuota12Ars: row.cuota_12_ars != null ? Number(row.cuota_12_ars) : 0,
    cuota18Ars: row.cuota_18_ars != null ? Number(row.cuota_18_ars) : 0,
  };
}

function receivableFromRow(row) {
  const k = row.kind;
  const kind = k === "tarjeta" || k === "otro" ? k : "cuotas";
  return {
    id: row.id,
    clientName: row.client_name,
    concept: row.concept || "",
    amountPending: Number(row.amount_pending ?? 0),
    dueDate: row.due_date || "",
    kind,
    notes: row.notes || "",
    createdAt: row.created_at,
  };
}

const INVOICE_TYPE_LABELS = {
  ticket: "Ticket",
  factura_a: "Factura A",
  factura_b: "Factura B",
  nota_credito: "Nota de crédito",
};

function invoiceFromRow(row) {
  return {
    id: row.id,
    saleId: row.sale_id,
    saleDate: row.sale_date || "",
    clientName: row.client_name || "",
    invoiceNumber: row.invoice_number || "",
    invoiceType: row.invoice_type || "ticket",
    issueDate: row.issue_date,
    subtotal: Number(row.subtotal ?? 0),
    taxPct: Number(row.tax_pct ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    total: Number(row.total ?? 0),
    notes: row.notes || "",
    status: row.status || "emitido",
    createdAt: row.created_at,
  };
}

function getSales() {
  const list = useCloud ? cacheSales : readList(KEYS.sales);
  return list.map((s) => normalizeSale(s));
}

function getCash() {
  return useCloud ? cacheCash : readList(KEYS.cash);
}

function normalizeInvItem(item) {
  if (!item) return item;
  const price = numeric(item.price, 0);
  const def = invMetaFromPrice(price);
  return {
    ...item,
    serial: item.serial || "",
    imei: item.imei || "",
    category: normalizeInvCategory(item.category ?? def.category),
    flagTecnico: item.flagTecnico === true,
    flagOnline: item.flagOnline !== false,
    flagVendible:
      item.flagVendible === false ? false : item.flagVendible === true ? true : price > 0,
    createdAt: item.createdAt || item.updatedAt || null,
  };
}

function getInventory() {
  const list = useCloud ? cacheInventory : readList(KEYS.inventory);
  return (Array.isArray(list) ? list : []).map(normalizeInvItem);
}

function getReceivables() {
  return useCloud ? cacheReceivables : readList(KEYS.receivables);
}

function getInvoices() {
  const list = useCloud ? cacheInvoices : readList(KEYS.invoices);
  return Array.isArray(list) ? list : [];
}

function getPipelineLeads() {
  const list = useCloud ? cachePipelineLeads : readList(KEYS.pipelineLeads);
  return list.map((x) => normalizePipelineLead(x));
}

function sumPendingReceivables() {
  return getReceivables().reduce((a, r) => a + Math.max(0, numeric(r.amountPending, 0)), 0);
}

function sortedReceivablesList() {
  return getReceivables()
    .slice()
    .sort((a, b) => {
      const da = a.dueDate || "";
      const db = b.dueDate || "";
      if (da && db) return da.localeCompare(db);
      if (da) return -1;
      if (db) return 1;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
}

const RECEIVABLE_KIND_LABEL = {
  cuotas: "Cuotas / plan",
  tarjeta: "Tarjeta (demora)",
  otro: "Otro",
};

const PIPELINE_STAGE_LABELS = {
  nuevo: "Nuevo",
  contactado: "Contactado",
  interesado: "Interesado",
  plan_canje: "Plan canje",
  cita: "Cita",
  venta: "Venta",
  perdido: "Perdido",
};

const PIPELINE_SOURCE_LABELS = {
  manual: "Manual",
  manychat: "ManyChat",
  meta_ads: "Meta / Ads",
  organic: "Orgánico",
  otro: "Otro",
};

/** Orden de columnas en el tablero Kanban */
const PIPELINE_KANBAN_STAGES = [
  "nuevo",
  "contactado",
  "interesado",
  "plan_canje",
  "cita",
  "venta",
  "perdido",
];

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/** Mismo criterio que en pipeline: @usuario → usuario en minúsculas. */
function normalizeIgHandle(ig) {
  return String(ig || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function formatDateTimeShort(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function normalizePipelineLead(raw) {
  if (!raw) return raw;
  const meta = raw.metadata;
  return {
    id: raw.id,
    stage: raw.stage || "nuevo",
    source: raw.source || "manychat",
    manychatSubscriberId: raw.manychatSubscriberId ?? raw.manychat_subscriber_id ?? "",
    phone: raw.phone ?? "",
    name: raw.name ?? "",
    email: raw.email ?? "",
    igHandle: raw.igHandle ?? raw.ig_handle ?? "",
    metadata: meta && typeof meta === "object" ? meta : {},
    lastManychatAt: raw.lastManychatAt ?? raw.last_manychat_interaction_at ?? null,
    assignedTo: raw.assignedTo ?? raw.assigned_to ?? "",
    convertedSaleId: raw.convertedSaleId ?? raw.converted_sale_id ?? null,
    notes: raw.notes ?? "",
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at,
  };
}

function pipelineLeadFromRow(row) {
  return normalizePipelineLead({
    id: row.id,
    stage: row.stage,
    source: row.source,
    manychat_subscriber_id: row.manychat_subscriber_id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    ig_handle: row.ig_handle,
    metadata: row.metadata,
    last_manychat_interaction_at: row.last_manychat_interaction_at,
    assigned_to: row.assigned_to,
    converted_sale_id: row.converted_sale_id,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

async function refreshCloud() {
  if (!supabaseClient) return;
  const [salesRes, cashRes, invRes, recvRes, invcRes, sellersRes, histRes] = await Promise.all([
    supabaseClient.from("sales").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("cash_movements").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("inventory_items").select("*").order("model", { ascending: true }),
    supabaseClient.from("pending_receivables").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("invoices").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("salespeople").select("*").order("name", { ascending: true }),
    supabaseClient
      .from("device_unit_history")
      .select("*")
      .order("event_at", { ascending: false })
      .limit(3000),
  ]);

  if (salesRes.error) throw salesRes.error;
  if (cashRes.error) throw cashRes.error;
  if (invRes.error) throw invRes.error;
  if (recvRes.error) throw recvRes.error;
  if (invcRes.error) {
    const msg = invcRes.error.message || "";
    if (/relation|does not exist|not find.*invoices|schema cache/i.test(msg)) {
      console.warn("Facturación: ejecutá en Supabase el SQL CRM/supabase/migration_invoices.sql para activar la tabla.");
      cacheInvoices = [];
    } else {
      throw invcRes.error;
    }
  } else {
    cacheInvoices = (invcRes.data || []).map(invoiceFromRow);
  }

  if (sellersRes.error) {
    const msg = sellersRes.error.message || "";
    if (/relation|does not exist|not find.*salespeople|schema cache/i.test(msg)) {
      console.warn(
        "Vendedores: ejecutá en Supabase el SQL CRM/supabase/migration_sales_sellers.sql para activar la tabla salespeople."
      );
      if (!cacheSellers.length) {
        cacheSellers = readList(KEYS.sellers).map((x) => normalizeSeller(x));
      }
    } else {
      throw sellersRes.error;
    }
  } else {
    cacheSellers = (sellersRes.data || []).map(sellerFromRow);
  }

  const settingsRes = await supabaseClient
    .from("crm_settings")
    .select("dolar_blue_ars_per_usd")
    .maybeSingle();
  if (settingsRes.error) {
    const msg = settingsRes.error.message || "";
    if (/relation|does not exist|not find.*crm_settings|schema cache/i.test(msg)) {
      console.warn(
        "CRM settings: ejecutá en Supabase el SQL CRM/supabase/migration_crm_settings.sql para guardar el dólar blue en la nube."
      );
      cacheCrmSettings = null;
    } else {
      throw settingsRes.error;
    }
  } else if (settingsRes.data && settingsRes.data.dolar_blue_ars_per_usd != null) {
    cacheCrmSettings = {
      dolarBlueArsPerUsd: Number(settingsRes.data.dolar_blue_ars_per_usd),
    };
    mergeCloudDolarIntoLocalStorageGoals();
    const dbEl = document.getElementById("goal-dolar-blue");
    if (dbEl) {
      const d = Number(cacheCrmSettings.dolarBlueArsPerUsd);
      dbEl.value = Number.isFinite(d) && d > 0 ? String(d) : "";
    }
  } else {
    cacheCrmSettings = null;
  }

  if (histRes.error) {
    const msg = histRes.error.message || "";
    if (/relation|does not exist|not find.*device_unit_history|schema cache/i.test(msg)) {
      console.warn(
        "Historial por serie/IMEI: ejecutá CRM/supabase/migration_device_unit_history.sql en Supabase."
      );
      cacheDeviceHistory = readList(KEYS.deviceHistory).map((x) =>
        deviceHistoryFromRow({ ...x, event_type: x.eventType, event_at: x.eventAt })
      );
    } else {
      throw histRes.error;
    }
  } else {
    cacheDeviceHistory = (histRes.data || []).map(deviceHistoryFromRow);
  }

  cacheSales = (salesRes.data || []).map(saleFromRow);
  cacheCash = (cashRes.data || []).map(cashFromRow);
  cacheInventory = (invRes.data || []).map(invFromRow);
  cacheReceivables = (recvRes.data || []).map(receivableFromRow);

  const pipeRes = await supabaseClient
    .from("pipeline_leads")
    .select("*")
    .order("created_at", { ascending: false });
  if (pipeRes.error) {
    const msg = pipeRes.error.message || "";
    if (/relation|does not exist|not find.*pipeline_leads|schema cache/i.test(msg)) {
      console.warn(
        "Pipeline: ejecutá en Supabase el SQL CRM/supabase/migration_pipeline_leads.sql para activar la tabla."
      );
      cachePipelineLeads = [];
    } else {
      throw pipeRes.error;
    }
  } else {
    cachePipelineLeads = (pipeRes.data || []).map(pipelineLeadFromRow);
  }
}

function setTodayDefaults() {
  const now = new Date();
  if (saleDate) saleDate.valueAsDate = now;
  if (cashDate) cashDate.valueAsDate = now;
  if (invoiceDate) invoiceDate.valueAsDate = now;
  if (techExpenseDate) techExpenseDate.valueAsDate = now;
}

function hideSaleModal() {
  if (!saleModal) return;
  saleModal.hidden = true;
  saleModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sale-modal-open");
}

function resetSaleModalFields() {
  editingSaleId = null;
  saleModalEditMode = false;
  if (saleEditHintEl) saleEditHintEl.hidden = true;
  if (saleModalTitleEl) saleModalTitleEl.textContent = "Nueva venta";
  if (saleFormSubmitBtn) saleFormSubmitBtn.textContent = "Guardar venta";
  if (saleAddCartBtn) saleAddCartBtn.disabled = false;
  if (saleCartClearBtn) saleCartClearBtn.disabled = false;

  saleCart = [];
  if (saleForm) {
    saleForm.reset();
  }
  if (salePickInventory) salePickInventory.value = "";
  if (saleQuantity) saleQuantity.value = "1";
  if (saleTradeInValue) saleTradeInValue.value = "0";
  if (salePayCash) salePayCash.value = "0";
  if (salePayTransfer) salePayTransfer.value = "0";
  if (salePayCard) salePayCard.value = "0";
  if (salePayOther) salePayOther.value = "0";
  if (saleClientSelect) saleClientSelect.value = "__new__";
  if (saleSeller) saleSeller.value = "";
  setTodayDefaults();
  renderSaleCart();
}

function openSaleModalForEdit(saleId) {
  const sale = getSales().find((s) => String(s.id) === String(saleId));
  if (!sale) return;
  if (!saleModal) return;

  resetSaleModalFields();

  editingSaleId = sale.id;
  saleModalEditMode = true;
  if (saleModalTitleEl) saleModalTitleEl.textContent = "Editar venta";
  if (saleFormSubmitBtn) saleFormSubmitBtn.textContent = "Guardar cambios";
  if (saleEditHintEl) saleEditHintEl.hidden = false;
  if (saleAddCartBtn) saleAddCartBtn.disabled = true;
  if (saleCartClearBtn) saleCartClearBtn.disabled = true;

  if (saleDate) saleDate.value = sale.date || "";
  if (saleClient) saleClient.value = (sale.client || "").trim();
  if (salePhone) salePhone.value = (sale.phone || "").trim();
  if (saleIg) saleIg.value = (sale.igHandle || "").trim();
  refreshSaleClientSelect();
  if (saleClientSelect) {
    const nm = (sale.client || "").trim();
    if (nm && [...saleClientSelect.options].some((o) => o.value === nm)) {
      saleClientSelect.value = nm;
    } else {
      saleClientSelect.value = "__new__";
    }
  }

  if (salePickInventory) salePickInventory.value = "";
  if (saleModel) saleModel.value = sale.model || "";
  if (saleColor) saleColor.value = sale.color || "";
  if (saleStorage) saleStorage.value = sale.storage || "";
  if (saleBattery) {
    saleBattery.value =
      sale.battery === "" || sale.battery == null ? "" : String(sale.battery);
  }
  if (saleImei) {
    const sid = resolveSaleDeviceIdentity(sale);
    saleImei.value = sid.imei || sid.serial || (sale.imei || "").trim();
  }
  if (saleQuantity) saleQuantity.value = String(Math.max(1, numeric(sale.quantity, 1)));
  if (salePrice) salePrice.value = String(numeric(sale.unitSale, 0));
  if (saleCost) saleCost.value = String(numeric(sale.unitCost, 0));

  const editDevId = resolveSaleDeviceIdentity(sale);
  saleCart = [
    {
      id: crypto.randomUUID(),
      inventoryId: "",
      model: (sale.model || "").trim(),
      color: (sale.color || "").trim(),
      storage: (sale.storage || "").trim(),
      battery: sale.battery === "" || sale.battery == null ? "" : String(sale.battery),
      serial: editDevId.serial,
      imei: editDevId.imei,
      quantity: numeric(sale.quantity, 1),
      unitSale: numeric(sale.unitSale, 0),
      unitCost: numeric(sale.unitCost, 0),
      deductInventory: sale.deductFromInventory !== false,
      matchId: null,
    },
  ];
  renderSaleCart();

  if (saleTradeInDesc) saleTradeInDesc.value = (sale.tradeInDescription || "").trim();
  if (saleTradeInValue) saleTradeInValue.value = String(numeric(sale.tradeInValue, 0));
  if (saleTradeInModel) saleTradeInModel.value = (sale.tradeInInvModel || "").trim();
  if (saleTradeInColor) saleTradeInColor.value = (sale.tradeInInvColor || "").trim();
  if (saleTradeInStorage) saleTradeInStorage.value = (sale.tradeInInvStorage || "").trim();
  if (saleTradeInBattery) {
    const tb = sale.tradeInInvBattery;
    saleTradeInBattery.value = tb === "" || tb == null ? "" : String(tb);
  }
  if (saleTradeInInvPrice) saleTradeInInvPrice.value = "";

  if (salePayCash) salePayCash.value = String(numeric(sale.paymentCash, 0));
  if (salePayTransfer) salePayTransfer.value = String(numeric(sale.paymentTransfer, 0));
  if (salePayCard) salePayCard.value = String(numeric(sale.paymentCard, 0));
  if (salePayOther) salePayOther.value = String(numeric(sale.paymentOther, 0));
  if (salePayment) salePayment.value = (sale.payment || "").trim();

  refreshSaleSellerSelect();

  saleModal.hidden = false;
  saleModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
  refreshSaleInventoryPickList();
  updateSaleCheckoutSummary();
  requestAnimationFrame(() => {
    if (saleClient) saleClient.focus();
  });
}

function openSaleModal() {
  if (!saleModal) return;
  resetSaleModalFields();
  saleModal.hidden = false;
  saleModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
  refreshSaleInventoryPickList();
  refreshSaleClientSelect();
  refreshSaleSellerSelect();
  requestAnimationFrame(() => {
    if (saleDate) saleDate.focus();
  });
}

function closeSaleModalInteractive() {
  if (!saleModal || saleModal.hidden) return;
  if (saleModalEditMode || saleCart.length > 0) {
    const msg = saleModalEditMode
      ? "¿Cerrar sin guardar los cambios en la venta?"
      : "¿Cerrar sin guardar? Se vaciará el carrito.";
    if (!confirm(msg)) return;
  }
  resetSaleModalFields();
  hideSaleModal();
}

const PAGE_TAB_COPY = {
  resumen: {
    title: "Resumen",
    subtitle: "Ventas, canjes, inventario y garantías 30 días",
  },
  ventas: {
    title: "Ventas",
    subtitle: "Registrar ventas, carrito y cobros",
  },
  pipeline: {
    title: "Pipeline",
    subtitle: "Leads y seguimiento de oportunidades",
  },
  garantias: {
    title: "Garantías",
    subtitle: "Seguimiento de equipos en garantía 30 días",
  },
  "servicio-tecnico": {
    title: "Servicio técnico",
    subtitle: "Equipos en taller, gastos de reparación y egresos",
  },
  caja: {
    title: "Caja",
    subtitle: "Ingresos y egresos del día a día",
  },
  facturacion: {
    title: "Facturación",
    subtitle: "Comprobantes y exportación",
  },
  deudores: {
    title: "Deudores",
    subtitle: "Cuotas y cobros pendientes",
  },
  inventario: {
    title: "Inventario",
    subtitle: "Stock, costos y equipos disponibles",
  },
  "simulador-cuotas": {
    title: "Simulador de cuotas",
    subtitle: "Cuota mensual de referencia en pesos (3, 6, 12 y 18)",
  },
  configuraciones: {
    title: "Configuraciones",
    subtitle: "Metas del negocio o vendedores: una sección por pantalla (elegí arriba)",
  },
  ayuda: {
    title: "Ayuda",
    subtitle: "Guía rápida del CRM",
  },
};

function updateMainHeader(tabName) {
  const copy = PAGE_TAB_COPY[tabName] || PAGE_TAB_COPY.resumen;
  const titleEl = document.getElementById("main-page-title");
  const subEl = document.getElementById("main-page-subtitle");
  if (titleEl) {
    titleEl.textContent =
      String(document.documentElement.dataset.theme || "").startsWith("app") && APP_SIMPLE_TITLES[tabName]
        ? APP_SIMPLE_TITLES[tabName]
        : copy.title;
  }
  if (subEl) {
    subEl.textContent =
      isStaffMode() && tabName === "inventario"
        ? "Stock para consultar y armar listas de WhatsApp"
        : copy.subtitle;
  }
  const periodBar = document.getElementById("app-period-bar");
  if (periodBar) periodBar.hidden = isStaffMode();
  updatePeriodBarNote();
}

const CONFIG_SUBPANELS = ["metas", "vendedores", "creativos"];

function getConfigSubpanel() {
  try {
    const v = localStorage.getItem(KEYS.configSubpanel);
    if (CONFIG_SUBPANELS.includes(v)) return v;
  } catch (_) {
    /* — */
  }
  return "metas";
}

function setConfigSubpanel(id) {
  try {
    localStorage.setItem(KEYS.configSubpanel, id);
  } catch (_) {
    /* — */
  }
}

function switchConfigSubpanel(panelId) {
  const id = CONFIG_SUBPANELS.includes(panelId) ? panelId : "metas";
  for (const key of CONFIG_SUBPANELS) {
    const panel = document.getElementById(`config-panel-${key}`);
    const tab = document.getElementById(`config-tab-${key}`);
    if (panel) panel.hidden = key !== id;
    if (tab) {
      tab.classList.toggle("active", key === id);
      tab.setAttribute("aria-selected", key === id ? "true" : "false");
    }
  }
  if (id === "creativos") hydrateCreativosConfigForm();
  setConfigSubpanel(id);
}

function switchTab(tabName) {
  if (isStaffMode() && !STAFF_TABS.has(tabName)) {
    tabName = "inventario";
  }
  tabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
  updateMainHeader(tabName);
  if (tabName === "configuraciones") {
    switchConfigSubpanel(getConfigSubpanel());
  }
  // Close any open modals when switching tabs
  if (typeof closeRefPreview === "function") closeRefPreview();
  document.body.style.overflow = "";
  syncAppDock(tabName);
}

const APP_DOCK_MAIN = ["resumen", "inventario", "ventas", "simulador-cuotas"];

const APP_SIMPLE_TITLES = {
  resumen: "Inicio",
  inventario: "Elegí el iPhone",
  ventas: "Ventas",
  "simulador-cuotas": "¿En cuántas cuotas?",
  caja: "Plata de caja",
};

function goToStockSearch(query) {
  switchTab("inventario");
  const search = document.getElementById("inv-stock-search");
  if (!(search instanceof HTMLInputElement)) return;
  if (query != null) search.value = query;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  search.focus();
}

function syncAppDock(tabName) {
  document.querySelectorAll(".app-dock-btn[data-dock]").forEach((btn) => {
    const dock = btn.dataset.dock;
    const on =
      dock === tabName ||
      (dock === "mas" && tabName && !APP_DOCK_MAIN.includes(tabName) && tabName !== "ventas");
    btn.classList.toggle("is-on", on);
  });
  const more = document.getElementById("app-more");
  if (more && APP_DOCK_MAIN.includes(tabName)) more.hidden = true;
}

function syncAppSheets() {
  const more = document.getElementById("app-more");
  const add = document.getElementById("app-add");
  const open = Boolean((more && !more.hidden) || (add && !add.hidden));
  document.body.classList.toggle("app-sheet-open", open);
}

function setAppAddOpen(open) {
  const sheet = document.getElementById("app-add");
  const btn = document.querySelector('.app-dock-add[data-dock="vender"]');
  if (sheet) sheet.hidden = !open;
  btn?.classList.toggle("is-on", Boolean(open));
  if (open) {
    const more = document.getElementById("app-more");
    if (more) more.hidden = true;
  }
  syncAppSheets();
}

function bindAppDock() {
  const dock = document.getElementById("app-dock");
  const more = document.getElementById("app-more");
  const add = document.getElementById("app-add");
  if (!dock || dock.dataset.bound === "1") return;
  dock.dataset.bound = "1";
  dock.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dock]");
    if (!(btn instanceof HTMLElement)) return;
    if (btn.dataset.dock === "mas") {
      setAppAddOpen(false);
      if (more) more.hidden = !more.hidden;
      syncAppSheets();
      return;
    }
    if (more) more.hidden = true;
    syncAppSheets();
    if (btn.dataset.dock === "vender") {
      setAppAddOpen(Boolean(add?.hidden));
      return;
    }
    setAppAddOpen(false);
    switchTab(btn.dataset.dock);
  });
  add?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.add;
    setAppAddOpen(false);
    if (action === "venta") {
      switchTab("ventas");
      openSaleModal();
      return;
    }
    if (action === "equipo") {
      switchTab("inventario");
      openInventoryModalForNew();
      return;
    }
    if (action === "lista") void copyReadyInvWhatsAppList(btn);
  });
  more?.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!(btn instanceof HTMLElement) || !more.contains(btn)) return;
    more.hidden = true;
    syncAppSheets();
    if (btn.dataset.open === "clients") {
      openClientsModal();
      return;
    }
    if (btn.dataset.open === "track") {
      openDeviceHistoryModal();
      return;
    }
    if (btn.dataset.tab) switchTab(btn.dataset.tab);
  });
  const quick = document.getElementById("app-quick");
  quick?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-go]");
    if (!(btn instanceof HTMLElement)) return;
    const go = btn.dataset.go;
    if (go === "caja") {
      setAppAddOpen(false);
      switchTab("caja");
      return;
    }
    if (go === "cobrar") {
      setAppAddOpen(false);
      switchTab("deudores");
      return;
    }
    if (go === "lista") {
      void copyReadyInvWhatsAppList(btn);
      return;
    }
    if (go === "clientes") openClientsModal();
  });
}

/** Navegación desde alertas del Resumen → pestaña + filtro + scroll al ítem. */
let pendingAlertNav = null;

function navigateToAlert(nav) {
  if (!nav?.tab) return;
  pendingAlertNav = nav;

  if (nav.filters) {
    for (const [viewId, patch] of Object.entries(nav.filters)) {
      writeViewFilters(viewId, patch);
    }
  }
  if (nav.inputs) {
    for (const [elId, value] of Object.entries(nav.inputs)) {
      const el = document.getElementById(elId);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(value);
      else el.value = value;
    }
  }

  switchTab(nav.tab);
  if (nav.tab === "configuraciones" && nav.configSubpanel) {
    switchConfigSubpanel(nav.configSubpanel);
  }

  renderAll();

  requestAnimationFrame(() => {
    setTimeout(() => applyPendingAlertNav(), 120);
  });
}

function applyPendingAlertNav() {
  const nav = pendingAlertNav;
  if (!nav) return;
  pendingAlertNav = null;

  let target = null;
  if (nav.highlightSaleId) {
    target =
      document.querySelector(`tr[data-sale-id="${CSS.escape(String(nav.highlightSaleId))}"]`) ||
      document.querySelector(`.warranty-tile[data-sale-id="${CSS.escape(String(nav.highlightSaleId))}"]`);
  }
  if (!target && nav.highlightRecvId) {
    target = document.querySelector(`tr[data-recv-id="${CSS.escape(String(nav.highlightRecvId))}"]`);
  }
  if (!target && nav.highlightInvId) {
    target = document.querySelector(`.inv-unit[data-id="${CSS.escape(String(nav.highlightInvId))}"]`);
    if (target) {
      const block = target.closest(".inv-model-block");
      if (block?.classList.contains("inv-model-block--closed")) {
        const key = block.dataset.modelKey;
        if (key) toggleInvModelGroup(key);
      }
    }
  }
  if (!target && nav.scrollTo) {
    target = document.querySelector(nav.scrollTo);
  }
  if (!target && nav.highlightSaleIds?.length) {
    target = document.querySelector(".alert-row--match");
  }

  if (target) {
    target.classList.add("alert-target-highlight");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => target.classList.remove("alert-target-highlight"), 5500);
  }

  if (nav.openSaleId) {
    openSaleModalForEdit(nav.openSaleId);
  }
  if (nav.openWeekClose) {
    window.__businessExtras?.openWeekCloseModal?.();
  }
}

async function refreshCloudUserDisplay() {
  const btn = document.getElementById("btn-user-meta");
  if (!btn) return;
  if (!isCloudConfigured() || !supabaseClient || cloudConnecting) {
    btn.hidden = true;
    btn.removeAttribute("title");
    delete btn.dataset.userId;
    return;
  }
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || !data.user) {
    btn.hidden = true;
    btn.removeAttribute("title");
    delete btn.dataset.userId;
    return;
  }
  const id = data.user.id;
  btn.dataset.userId = id;
  btn.title = `${id}\n\nClic para copiar al portapapeles`;
  btn.hidden = !useCloud;
}

function setConnectionPill(lead, detail, modifierClass, title = "") {
  if (!connectionStatus) return;
  connectionStatus.className = `header-icon-btn header-icon-btn--status ${modifierClass}`.trim();
  if (connectionStatusLead) connectionStatusLead.textContent = lead;
  if (connectionStatusDetail) connectionStatusDetail.textContent = detail;
  else connectionStatus.textContent = `${lead} ${detail}`;
  const tip = title || `${lead}\n${detail}`;
  connectionStatus.title = tip;
  connectionStatus.setAttribute("aria-label", `${lead}. ${detail}`);
}

function updateConnectionUI() {
  if (!connectionStatus) return;
  if (btnLogoutSupabase) {
    btnLogoutSupabase.hidden = !isCloudConfigured() || !supabaseClient || !useCloud;
  }
  void refreshCloudUserDisplay();
  if (!isCloudConfigured()) {
    setConnectionPill(
      "Solo navegador — no hay Supabase",
      "Falta URL y clave en config.js. Nada se guarda en la nube.",
      "connection-pill--local",
      ""
    );
    return;
  }
  if (cloudConnecting) {
    setConnectionPill(
      useCloud ? "Leyendo la base…" : "Conectando con la base…",
      useCloud
        ? "Actualizando ventas, caja, inventario y pipeline desde PostgreSQL."
        : "Iniciando sesión y cargando datos. Esperá unos segundos.",
      "connection-pill--warn",
      ""
    );
    return;
  }
  const ns = useCloud ? cacheSales.length : readList(KEYS.sales).length;
  const nc = useCloud ? cacheCash.length : readList(KEYS.cash).length;
  const ni = useCloud ? cacheInventory.length : readList(KEYS.inventory).length;
  const nr = useCloud ? cacheReceivables.length : readList(KEYS.receivables).length;
  const nif = useCloud ? cacheInvoices.length : readList(KEYS.invoices).length;
  const np = useCloud ? cachePipelineLeads.length : readList(KEYS.pipelineLeads).length;
  const host = getSupabaseHost();
  if (useCloud) {
    const detail = host
      ? `${ns} ventas · ${nc} caja · ${ni} inv. · ${nr} pend. · ${nif} facturas · ${np} pipeline · ${host} · tiempo real`
      : `${ns} ventas · ${nc} caja · ${ni} inv. · ${nr} pend. · ${nif} facturas · ${np} pipeline · tiempo real`;
    if (ns + nc + ni + nr + nif + np === 0) {
      setConnectionPill(
        "Conectado — pero la base te devolvió 0 filas",
        "Revisá RLS y que user_id en las tablas sea el UUID que mostramos abajo (Copiar).",
        "connection-pill--warn",
        "Si en Table Editor ves datos y acá no, casi siempre es user_id distinto al de tu sesión."
      );
    } else {
      setConnectionPill(
        "Sí: guardás en la base de datos",
        detail,
        "connection-pill--cloud",
        "Cada cambio se escribe en Supabase (PostgreSQL). Podés comprobarlo en el Table Editor."
      );
    }
    return;
  }
  if (loginPanelVisible) {
    setConnectionPill(
      "Iniciá sesión en el panel",
      "Ventana de login abierta. O usá «solo navegador» para trabajar sin Supabase.",
      "connection-pill--warn",
      ""
    );
    return;
  }
  setConnectionPill(
    "No: solo estás en el navegador",
    "No hay sesión con PostgreSQL. Recargá la página para ver el login o revisá config.js.",
    "connection-pill--warn",
    "Sin sesión válida la app usa solo localStorage; eso no es tu base en la nube."
  );
}

function renderSales() {
  const vf = readViewFilters("sales");
  let sales = getSales().slice();
  sales = filterRowsByActiveMonth(sales, "sales", (s) => s.date);
  const q = (document.getElementById("sales-filter-q")?.value || vf.q || "").trim();
  if (q) {
    sales = sales.filter((s) =>
      textIncludesQuery(
        [s.client, s.phone, s.model, s.color, s.storage, s.igHandle, s.imei].filter(Boolean).join(" "),
        q
      )
    );
  }
  sales.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  salesBody.innerHTML = "";
  if (sales.length === 0) {
    renderViewFilterEmptyRow(salesBody, 9, "sales", "ventas");
    return;
  }

  sales.forEach((sale) => {
    const row = document.createElement("tr");
    row.dataset.saleId = String(sale.id);
    const hiIds = pendingAlertNav?.highlightSaleIds?.map(String) || [];
    if (hiIds.includes(String(sale.id))) row.classList.add("alert-row--match");
    row.innerHTML = `
      <td>${sale.date}</td>
      <td><button type="button" class="linkish sale-client-btn" data-client="${escapeHtml(sale.client)}">${escapeHtml(sale.client)}</button><div class="muted">${escapeHtml(sale.phone || "—")}</div>${
        sale.igHandle
          ? `<div class="muted">${escapeHtml(sale.igHandle.startsWith("@") ? sale.igHandle : `@${sale.igHandle}`)}</div>`
          : ""
      }</td>
      <td>${formatSaleSellerCell(sale)}</td>
      <td>${escapeHtml(sale.model)}<div class="muted">${escapeHtml(sale.color || "-")} | ${escapeHtml(
        sale.storage || "-"
      )} | Bat: ${toBatteryLabel(sale.battery)}</div>${buildSaleDeviceIdentityCellHtml(sale)}</td>
      <td>${sale.quantity}</td>
      <td>${currency(sale.saleTotal)}</td>
      <td class="payment-summary">${formatPaymentSummary(sale)}</td>
      <td>${formatSaleProfitCell(sale)}</td>
      <td>
        <button type="button" class="secondary edit-sale-btn" data-id="${sale.id}">Editar</button>
        <button class="delete-btn" data-id="${sale.id}" data-type="sale">Eliminar</button>
      </td>
    `;
    salesBody.appendChild(row);
  });
}

const VENDEDORES_STATS_ALL = "__all__";

function getVendedoresStatsMonthKey() {
  const sel = document.getElementById("vendedores-stats-month");
  if (sel && sel.value) return sel.value;
  try {
    const stored = localStorage.getItem(KEYS.vendedoresStatsMonth);
    if (stored) return stored;
  } catch (_) {
    /* — */
  }
  return VENDEDORES_STATS_ALL;
}

function persistVendedoresStatsMonth(key) {
  try {
    localStorage.setItem(KEYS.vendedoresStatsMonth, key);
  } catch (_) {
    /* — */
  }
}

function populateVendedoresStatsMonthSelect() {
  const sel = document.getElementById("vendedores-stats-month");
  if (!sel) return;
  const keep = sel.value || localStorage.getItem(KEYS.vendedoresStatsMonth) || VENDEDORES_STATS_ALL;
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = VENDEDORES_STATS_ALL;
  all.textContent = "Todos los períodos";
  sel.appendChild(all);
  const now = new Date();
  for (let i = 0; i < DASHBOARD_MONTH_RANGE; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKeyFromDate(d);
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = monthKeyToLabel(key);
    sel.appendChild(opt);
  }
  const ok = [...sel.options].some((o) => o.value === keep);
  sel.value = ok ? keep : VENDEDORES_STATS_ALL;
  persistVendedoresStatsMonth(sel.value);
}

function salesForVendedoresStatsFilter(sales) {
  const mk = getDashboardMonthKey();
  return salesForMonthKey(sales, mk);
}

function clearSellerEdit() {
  editingSellerId = null;
  if (sellerEditHintEl) sellerEditHintEl.hidden = true;
  if (sellerFormSubmitBtn) sellerFormSubmitBtn.textContent = "Agregar vendedor";
  if (btnSellerCancelEdit) btnSellerCancelEdit.hidden = true;
  sellerForm?.reset();
  if (sellerActive) sellerActive.checked = true;
  if (sellerCommissionPct) sellerCommissionPct.value = "0";
}

function renderSellersTable() {
  if (!sellersBody) return;
  const list = getSellers().slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sellersBody.innerHTML = "";
  if (list.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="muted">Todavía no cargaste vendedores.</td>`;
    sellersBody.appendChild(tr);
    return;
  }
  for (const sp of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(sp.name)}</td>
      <td>${numeric(sp.commissionPct, 0).toLocaleString("es-AR", { maximumFractionDigits: 2 })}%</td>
      <td>${sp.active ? "Activo" : "Inactivo"}</td>
      <td>
        <button type="button" class="secondary edit-seller-btn" data-id="${sp.id}">Editar</button>
        <button type="button" class="delete-btn" data-id="${sp.id}" data-type="seller">Eliminar</button>
      </td>
    `;
    sellersBody.appendChild(tr);
  }
}

function renderSellerStats() {
  if (!sellerStatsBody) return;
  const sales = salesForVendedoresStatsFilter(getSales());
  sellerStatsBody.innerHTML = "";
  if (sales.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted">No hay ventas en el período elegido.</td>`;
    sellerStatsBody.appendChild(tr);
    return;
  }
  const emptyKey = "__none__";
  const bySeller = new Map();
  for (const sa of sales) {
    const sk = sa.sellerId || sa.seller_id || emptyKey;
    const row = bySeller.get(sk) || { count: 0, saleSum: 0, profitSum: 0, commSum: 0, commPending: 0 };
    row.count += 1;
    row.saleSum += numeric(sa.saleTotal, 0);
    row.profitSum += saleAdjustedProfit(sa);
    if (sk !== emptyKey) {
      const commAmt =
        numeric(sa.commissionAmount, 0) ||
        computeSaleCommission(String(sk), numeric(sa.saleTotal, 0)).commissionAmount;
      row.commSum += commAmt;
      if (commAmt > 0 && !sa.commissionPaid) row.commPending += commAmt;
    }
    bySeller.set(sk, row);
  }
  const keys = [...bySeller.keys()].sort((a, b) => {
    if (a === emptyKey) return 1;
    if (b === emptyKey) return -1;
    return String(getSellerNameById(a)).localeCompare(String(getSellerNameById(b)));
  });
  for (const k of keys) {
    const row = bySeller.get(k);
    if (!row || row.count === 0) continue;
    const name = k === emptyKey ? "Sin vendedor" : getSellerNameById(k) || "Vendedor";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(name)}</td>
      <td>${row.count}</td>
      <td>${currency(row.saleSum)}</td>
      <td>${currency(row.profitSum)}</td>
      <td>${currency(row.commSum)}</td>
      <td class="${row.commPending > 0 ? "text-warn" : ""}">${currency(row.commPending)}</td>
    `;
    sellerStatsBody.appendChild(tr);
  }
}

function warrantyTileTitle(sale) {
  const color = String(sale.color || "").trim();
  const storage = String(sale.storage || "").trim();
  const parts = [];
  if (color && color !== "Sin color") parts.push(color);
  if (storage && storage !== "Sin almacenamiento") parts.push(storage);
  if (parts.length) return parts.join(" · ");
  return String(sale.model || "").trim() || "Equipo";
}

function warrantySaleMatchesSearch(sale, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return true;
  const id = resolveSaleDeviceIdentity(sale);
  const hay = [
    sale.client,
    sale.phone,
    sale.igHandle,
    sale.model,
    sale.color,
    sale.storage,
    sale.battery,
    sale.date,
    id.serial,
    id.imei,
    sale.imei,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function getWarrantySalesForDisplay() {
  const vf = readViewFilters("warranty");
  const filter = warrantyFilter?.value || vf.status || "active";
  const q = warrantySearch?.value || vf.q || "";
  let sales = getSales().slice();
  sales = filterRowsByActiveMonth(sales, "warranty", (s) => s.date);
  const filtered = sales.filter((sale) => {
    const daysLeft = warrantyDaysRemaining(sale.date);
    const active = daysLeft >= 0;
    if (filter === "active" && !active) return false;
    if (filter === "expired" && active) return false;
    return warrantySaleMatchesSearch(sale, q);
  });
  filtered.sort((a, b) => {
    const da = warrantyDaysRemaining(a.date);
    const db = warrantyDaysRemaining(b.date);
    const aActive = da >= 0;
    const bActive = db >= 0;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive && bActive) return da - db;
    return String(b.date || "").localeCompare(String(a.date || ""));
  });
  return filtered;
}

function buildWarrantyDeviceIdBlockHtml(sale) {
  const id = resolveSaleDeviceIdentity(sale);
  if (id.imei) {
    return `<div class="warranty-tile__id"><span class="warranty-tile__id-k">IMEI</span><code>${escapeHtml(id.imei)}</code></div>`;
  }
  if (id.serial) {
    return `<div class="warranty-tile__id"><span class="warranty-tile__id-k">Serie</span><code>${escapeHtml(id.serial)}</code></div>`;
  }
  return `<p class="warranty-tile__id-miss muted">Sin serie ni IMEI en la venta</p>`;
}

function buildWarrantyTileHtml(sale) {
  const daysLeft = warrantyDaysRemaining(sale.date);
  const active = daysLeft >= 0;
  const endStr = warrantyEndDateStr(sale.date);
  const swatch = invColorSwatchHex(sale.color);
  const lightSwatch = ["#f4f4f5", "#fafafa", "#e7e5e4", "#d6d3d1"].includes(swatch);
  const statusClass = active
    ? daysLeft <= 3
      ? "warranty-tile--urgent"
      : "warranty-tile--active"
    : "warranty-tile--expired";
  const statusAccent = active ? (daysLeft <= 3 ? "#f59e0b" : "#22c55e") : "#94a3b8";
  const daysLabel = active
    ? daysLeft === 0
      ? "Último día"
      : `${daysLeft} día${daysLeft === 1 ? "" : "s"} restantes`
    : "Vencida";
  const stateBadge = active
    ? `<span class="warranty-tile__badge warranty-tile__badge--ok">Vigente</span>`
    : `<span class="warranty-tile__badge warranty-tile__badge--no">Vencida</span>`;
  const model = String(sale.model || "").trim();
  const title = warrantyTileTitle(sale);
  const titleHtml = model
    ? `<span class="warranty-tile__model">${escapeHtml(model)}</span><span class="warranty-tile__title-sep">·</span><span>${escapeHtml(title)}</span>`
    : escapeHtml(title);
  const bat = toBatteryLabel(sale.battery);
  const batHtml =
    bat && bat !== "-" ? `<li><span class="warranty-tile__attr-k">Bat.</span><span>${escapeHtml(bat)}</span></li>` : "";
  const clientSpan = escapeHtml(sale.client || "—");
  const phoneBit = sale.phone ? ` <span class="warranty-tile__phone">${escapeHtml(sale.phone)}</span>` : "";
  const id = resolveSaleDeviceIdentity(sale);
  const saleId = escapeHtml(String(sale.id));
  const hasDeviceId = Boolean(id.serial || id.imei);
  const inTech = isSaleInTechService(sale);
  const techBtn = inTech
    ? `<button type="button" class="secondary warranty-tech-btn" disabled title="Ya está en taller">En taller</button>`
    : hasDeviceId
      ? `<button type="button" class="secondary warranty-tech-btn" data-id="${saleId}">En taller</button>`
      : `<button type="button" class="secondary warranty-tech-btn" disabled title="Completá serie o IMEI en la venta">En taller</button>`;

  return `
    <article class="warranty-tile ${statusClass}${lightSwatch ? " warranty-tile--light-swatch" : ""}" data-sale-id="${saleId}" style="--warranty-accent:${swatch};--warranty-status:${statusAccent}">
      <div class="warranty-tile__surface">
        <div class="warranty-tile__top">
          <span class="warranty-tile__swatch" style="--swatch:${swatch}" aria-hidden="true"></span>
          <div class="warranty-tile__head-text">
            <h3 class="warranty-tile__title">${titleHtml}</h3>
            <div class="warranty-tile__status-row">${stateBadge}<span class="warranty-tile__days">${escapeHtml(daysLabel)}</span></div>
          </div>
        </div>
        <div class="warranty-tile__body">
          <ul class="warranty-tile__attrs">
            <li class="warranty-tile__attr--client"><span class="warranty-tile__attr-k">Cliente</span><span>${clientSpan}${phoneBit}</span></li>
            <li><span class="warranty-tile__attr-k">Plazo</span><span>${escapeHtml(sale.date || "—")} → ${escapeHtml(endStr)}</span></li>
            <li><span class="warranty-tile__attr-k">Total</span><span>${escapeHtml(currency(sale.saleTotal))}</span></li>
            ${batHtml}
          </ul>
          ${buildWarrantyDeviceIdBlockHtml(sale)}
        </div>
        <div class="warranty-tile__footer">
          ${techBtn}
          <button type="button" class="secondary warranty-history-btn" data-serial="${escapeHtml(id.serial)}" data-imei="${escapeHtml(id.imei)}">Historial</button>
          <button type="button" class="secondary warranty-edit-sale-btn" data-id="${saleId}">Venta</button>
        </div>
      </div>
    </article>`;
}

function renderWarranties() {
  if (!warrantyBody) return;
  const list = getWarrantySalesForDisplay();
  if (warrantyCountBadge) {
    const vigentes = list.filter((s) => warrantyDaysRemaining(s.date) >= 0).length;
    warrantyCountBadge.textContent =
      list.length === 0 ? "" : `${list.length} tarjeta(s) · ${vigentes} vigente(s)`;
  }
  if (warrantyEmpty) warrantyEmpty.hidden = list.length > 0;
  warrantyBody.innerHTML = list.length ? list.map((sale) => buildWarrantyTileHtml(sale)).join("") : "";
  const hiSale = pendingAlertNav?.highlightSaleId;
  if (hiSale) {
    const tile = warrantyBody.querySelector(`.warranty-tile[data-sale-id="${CSS.escape(String(hiSale))}"]`);
    if (tile) tile.classList.add("alert-row--match");
  }
}

function renderCash() {
  const vf = readViewFilters("cash");
  const cash = getCash();
  const sales = getSales();
  cashBody.innerHTML = "";

  let saleRows = sales.map((s) => ({
    date: s.date || "",
    type: "ingreso",
    concept: `Venta · ${s.client || "—"} · ${s.model || "Equipo"}`,
    amount: numeric(s.saleTotal, 0),
    isSale: true,
    saleId: s.id,
    repartoDest: "reparto",
  }));
  if (viewLimitsToActiveMonth("cash")) {
    const mk = getDashboardMonthKey();
    saleRows = saleRows.filter((r) => recordInMonth(r.date, mk));
  }

  let cashRows = cash.map((c) => ({
    date: c.date || "",
    type: c.type,
    concept: c.concept || "",
    amount: numeric(c.amount, 0),
    isSale: false,
    id: c.id,
    repartoDest: c.repartoDest,
    egresoKind: c.egresoKind,
  }));
  cashRows = filterRowsByActiveMonth(cashRows, "cash", (c) => c.date);

  const q = (document.getElementById("cash-filter-q")?.value || vf.q || "").trim();
  const typeF = document.getElementById("cash-filter-type")?.value || vf.type || "";
  const destF = document.getElementById("cash-filter-dest")?.value || vf.dest || "";

  let all = [...saleRows, ...cashRows];
  if (typeF === "venta") all = all.filter((item) => item.isSale);
  else if (typeF) all = all.filter((item) => !item.isSale && item.type === typeF);
  if (destF) {
    all = all.filter((item) => cashRepartoDestOf(item) === destF);
  }
  if (q) {
    all = all.filter((item) => textIncludesQuery(item.concept, q));
  }
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  if (all.length === 0) {
    renderViewFilterEmptyRow(cashBody, 6, "cash", "movimientos de caja");
    return;
  }

  all.forEach((item) => {
    const row = document.createElement("tr");
    if (item.isSale) {
      row.className = "cash-row--sale";
      row.innerHTML = `
        <td>${escapeHtml(item.date)}</td>
        <td><span class="cash-type-badge cash-type-badge--venta">venta</span></td>
        <td><span class="cash-dest-badge">Reparto general</span></td>
        <td>${escapeHtml(item.concept)}</td>
        <td>${currency(item.amount)}</td>
        <td class="muted" style="font-size:12px">Desde Ventas</td>
      `;
    } else {
      const destLabel = repartoDestLabelForItem(item);
      const destClass = `cash-dest-badge cash-dest-badge--${cashRepartoDestOf(item)}`;
      row.innerHTML = `
        <td>${escapeHtml(item.date)}</td>
        <td>${escapeHtml(item.type)}</td>
        <td><span class="${destClass}">${escapeHtml(destLabel)}</span></td>
        <td>${escapeHtml(item.concept)}</td>
        <td>${currency(item.amount)}</td>
        <td>
          <button type="button" class="secondary edit-cash-btn" data-id="${item.id}">Editar</button>
          <button class="delete-btn" data-id="${item.id}" data-type="cash">Eliminar</button>
        </td>
      `;
    }
    cashBody.appendChild(row);
  });
}

function refreshInvoiceSaleOptions() {
  if (!invoiceSaleId) return;
  const sales = getSales().slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const current = invoiceSaleId.value;
  invoiceSaleId.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = sales.length ? "Elegí una venta" : "No hay ventas cargadas";
  invoiceSaleId.appendChild(empty);
  for (const s of sales) {
    const opt = document.createElement("option");
    opt.value = String(s.id);
    opt.textContent = `${s.date} · ${s.client} · ${s.model} · ${currency(s.saleTotal)}`;
    invoiceSaleId.appendChild(opt);
  }
  if (current && sales.some((s) => String(s.id) === current)) invoiceSaleId.value = current;
}

function nextInvoiceNumber(invoiceTypeId) {
  const prefix = {
    ticket: "TCK",
    factura_a: "FA",
    factura_b: "FB",
    nota_credito: "NC",
  }[invoiceTypeId] || "CB";
  const list = getInvoices().filter((x) => x.invoiceType === invoiceTypeId);
  let maxSeq = 0;
  for (const inv of list) {
    const m = String(inv.invoiceNumber || "").match(/-(\d{4,})$/);
    if (!m) continue;
    const seq = Number(m[1]);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}-${String(maxSeq + 1).padStart(6, "0")}`;
}

function renderInvoices() {
  if (!invoicesBody) return;
  const vf = readViewFilters("invoices");
  const bySale = new Map(getSales().map((s) => [String(s.id), s]));
  let invoices = getInvoices()
    .slice()
    .sort((a, b) => String(b.issueDate || b.createdAt || "").localeCompare(String(a.issueDate || a.createdAt || "")));
  invoices = filterRowsByActiveMonth(invoices, "invoices", (inv) => inv.issueDate || inv.createdAt);
  const q = (document.getElementById("invoices-filter-q")?.value || vf.q || "").trim();
  const statusF = document.getElementById("invoices-filter-status")?.value || vf.status || "";
  if (statusF === "emitido") invoices = invoices.filter((inv) => inv.status !== "anulado");
  else if (statusF === "anulado") invoices = invoices.filter((inv) => inv.status === "anulado");
  if (q) {
    invoices = invoices.filter((inv) => {
      const s = bySale.get(String(inv.saleId));
      return textIncludesQuery(
        [inv.invoiceNumber, inv.clientName, s?.client, s?.model].filter(Boolean).join(" "),
        q
      );
    });
  }
  invoicesBody.innerHTML = "";
  if (invoices.length === 0) {
    renderViewFilterEmptyRow(invoicesBody, 9, "invoices", "comprobantes");
    return;
  }
  for (const inv of invoices) {
    const s = bySale.get(String(inv.saleId));
    const taxLabel = `${numeric(inv.taxPct, 0).toFixed(2)}% (${currency(inv.taxAmount)})`;
    const status = inv.status === "anulado" ? "Anulado" : "Emitido";
    const saleLabel = s ? `${escapeHtml(s.model)} · ${currency(s.saleTotal)}` : "Venta eliminada";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${inv.issueDate || "—"}</td>
      <td><strong>${escapeHtml(inv.invoiceNumber || "—")}</strong></td>
      <td>${escapeHtml(INVOICE_TYPE_LABELS[inv.invoiceType] || inv.invoiceType || "—")}</td>
      <td>${escapeHtml(inv.clientName || s?.client || "—")}</td>
      <td>${saleLabel}</td>
      <td>${taxLabel}</td>
      <td>${currency(inv.total)}</td>
      <td>${status}</td>
      <td class="invoice-actions">${
        `<button class="secondary invoice-pdf-btn" data-id="${inv.id}">PDF</button> `
      }${
        inv.status === "anulado"
          ? '<span class="muted">—</span>'
          : `<button type="button" class="secondary invoice-edit-btn" data-id="${inv.id}">Editar</button> <button class="secondary invoice-void-btn" data-id="${inv.id}">Anular</button>`
      }</td>
    `;
    invoicesBody.appendChild(row);
  }
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadInvoicesCsv() {
  const salesById = new Map(getSales().map((s) => [String(s.id), s]));
  const rows = getInvoices().map((inv) => {
    const s = salesById.get(String(inv.saleId));
    return [
      inv.issueDate || "",
      inv.invoiceNumber || "",
      INVOICE_TYPE_LABELS[inv.invoiceType] || inv.invoiceType || "",
      inv.status || "",
      inv.clientName || s?.client || "",
      s?.model || "",
      numeric(inv.subtotal, 0).toFixed(2),
      numeric(inv.taxPct, 0).toFixed(2),
      numeric(inv.taxAmount, 0).toFixed(2),
      numeric(inv.total, 0).toFixed(2),
      inv.notes || "",
    ];
  });
  const header = [
    "fecha_emision",
    "numero",
    "tipo",
    "estado",
    "cliente",
    "producto",
    "subtotal_usd",
    "impuesto_pct",
    "impuesto_usd",
    "total_usd",
    "notas",
  ];
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const today = new Date().toISOString().slice(0, 10);
  a.download = `facturacion_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getInvoiceForPdfById(invoiceId) {
  const inv = getInvoices().find((x) => String(x.id) === String(invoiceId));
  if (!inv) return null;
  const sale = getSales().find((s) => String(s.id) === String(inv.saleId)) || null;
  return { inv, sale };
}

function downloadInvoicePdf(invoiceId) {
  const pack = getInvoiceForPdfById(invoiceId);
  if (!pack) {
    alert("No se encontró el comprobante.");
    return;
  }
  const { inv, sale } = pack;
  const jsPdfApi = window.jspdf;
  const JsPdfCtor = jsPdfApi && jsPdfApi.jsPDF;
  if (!JsPdfCtor) {
    alert("No se pudo cargar el motor PDF. Recargá la página e intentá de nuevo.");
    return;
  }

  const doc = new JsPdfCtor({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 56;
  const left = 48;
  const right = pageWidth - 48;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("GO APPLE", left, y);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text("Comprobante de venta", left, y + 16);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(String(inv.invoiceNumber || "—"), right, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Estado: ${inv.status === "anulado" ? "ANULADO" : "EMITIDO"}`, right, y + 14, { align: "right" });
  y += 40;

  doc.setDrawColor(210, 210, 210);
  doc.line(left, y, right, y);
  y += 20;

  const saleTotal = numeric(sale?.saleTotal, numeric(inv.subtotal, 0));
  const saleDate = inv.saleDate || sale?.date || "—";
  const clientName = inv.clientName || sale?.client || "Consumidor final";
  const productLabel = sale
    ? `${sale.model} · ${sale.color || "-"} · ${sale.storage || "-"} · ${sale.quantity} u.`
    : "Venta asociada no disponible";
  const issueType = INVOICE_TYPE_LABELS[inv.invoiceType] || inv.invoiceType || "Comprobante";

  doc.setFont("helvetica", "bold");
  doc.text("Datos del comprobante", left, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.text(`Tipo: ${issueType}`, left, y);
  doc.text(`Fecha emisión: ${inv.issueDate || "—"}`, left + 220, y);
  y += 14;
  doc.text(`Fecha venta: ${saleDate}`, left, y);
  y += 14;
  doc.text(`Cliente: ${clientName}`, left, y);
  y += 14;
  doc.text(`Producto: ${productLabel}`, left, y);
  y += 22;

  doc.setFont("helvetica", "bold");
  doc.text("Detalle de importes (USD)", left, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.text(`Subtotal: ${currency(saleTotal)}`, left, y);
  y += 14;
  doc.text(`Impuesto (${numeric(inv.taxPct, 0).toFixed(2)}%): ${currency(inv.taxAmount)}`, left, y);
  y += 14;
  doc.setFont("helvetica", "bold");
  doc.text(`Total: ${currency(inv.total)}`, left, y);
  y += 24;
  doc.setFont("helvetica", "normal");
  if (inv.notes) {
    const wrapped = doc.splitTextToSize(`Notas: ${inv.notes}`, right - left);
    doc.text(wrapped, left, y);
    y += wrapped.length * 12 + 8;
  }

  doc.setFontSize(9);
  doc.setTextColor(110, 110, 110);
  doc.text(
    "Documento generado desde GO APPLE CRM. Guardar este PDF para respaldo y envío al cliente.",
    left,
    Math.min(y + 12, 780)
  );

  const safeNumber = String(inv.invoiceNumber || "comprobante").replace(/[^\w-]+/g, "_");
  doc.save(`${safeNumber}.pdf`);
}

function refreshSaleInventoryPickList() {
  if (!salePickInventory) return;
  const current = salePickInventory.value;
  const list = [...getInventory()].sort((a, b) => {
    const sa = a.stock > 0 ? 0 : 1;
    const sb = b.stock > 0 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return `${a.model} ${a.color}`.localeCompare(`${b.model} ${b.color}`, "es");
  });
  salePickInventory.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "— Manual / sin elegir fila —";
  salePickInventory.appendChild(opt0);
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = String(item.id);
    const bat =
      item.battery !== "" && item.battery != null ? ` · batería ${item.battery}%` : "";
    const rate = getDolarBlueArsPerUsd();
    const pa =
      item.priceArs != null && Number(item.priceArs) > 0
        ? Number(item.priceArs)
        : rate > 0
          ? Math.round(numeric(item.price, 0) * rate)
          : 0;
    const arsBit = pa > 0 ? ` · ${currencyArs(pa)}` : "";
    const ser = resolveInventorySerial(item);
    const imeiBit = resolveInventoryImei(item);
    const idBit = ser ? ` · ${ser}` : imeiBit ? ` · IMEI ${imeiBit}` : "";
    opt.textContent = `${item.stock} u. · ${item.model} · ${item.color} · ${item.storage}${bat}${idBit}${arsBit}`;
    salePickInventory.appendChild(opt);
  }
  if (current && list.some((i) => String(i.id) === current)) {
    salePickInventory.value = current;
  }
}

function inventoryModelGroupKey(model) {
  return String(model || "")
    .trim()
    .toLowerCase();
}

function loadInvModelGroupsExpanded() {
  try {
    const raw = sessionStorage.getItem(`${KEYS.inventory}_groups_exp`);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) {
    return new Set();
  }
}

let invModelGroupsExpanded = loadInvModelGroupsExpanded();

function saveInvModelGroupsExpanded() {
  try {
    sessionStorage.setItem(
      `${KEYS.inventory}_groups_exp`,
      JSON.stringify([...invModelGroupsExpanded])
    );
  } catch (_) {
    /* — */
  }
}

function isInvModelGroupCollapsed(modelKey) {
  return !invModelGroupsExpanded.has(String(modelKey));
}

function toggleInvModelGroup(modelKey) {
  if (!modelKey) return;
  const id = String(modelKey);
  if (invModelGroupsExpanded.has(id)) invModelGroupsExpanded.delete(id);
  else invModelGroupsExpanded.add(id);
  saveInvModelGroupsExpanded();
  const collapsed = !invModelGroupsExpanded.has(id);
  const block = inventoryStock?.querySelector(
    `.inv-model-block[data-model-key="${CSS.escape(id)}"]`
  );
  const panel = block?.querySelector(".inv-model-list");
  if (panel) panel.hidden = collapsed;
  block?.classList.toggle("inv-model-block--closed", collapsed);
  const btn = block?.querySelector(".inv-cat-row");
  if (btn) {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const hint = btn.querySelector(".inv-cat-row__hint");
    if (hint) hint.textContent = collapsed ? "Ver" : "Ocultar";
  }
}

function getInvUnitFlags(item) {
  return {
    tecnico: item?.flagTecnico === true,
  };
}

function getInvStockSearchQuery() {
  return (invStockSearch?.value || "").trim().toLowerCase();
}

function getInvStockFilterValue() {
  return invStockFilter?.value || "all";
}

function inventoryItemSearchBlob(item) {
  return [
    item.model,
    item.color,
    item.storage,
    item.serial,
    item.imei,
    item.notes,
    resolveInventorySerial(item),
    resolveInventoryImei(item),
    INV_CATEGORY_LABELS[normalizeInvCategory(item.category)] || "",
  ]
    .join(" ")
    .toLowerCase();
}

function inventoryItemMatchesSearch(item, query) {
  if (!query) return true;
  return inventoryItemSearchBlob(item).includes(query);
}

function inventoryItemMatchesFilter(item, filter) {
  const flags = getInvUnitFlags(item);
  const price = numeric(item.price, 0);
  const cost = numeric(item.cost, 0);
  const serial = resolveInventorySerial(item);
  const imei = resolveInventoryImei(item);
  switch (filter) {
    case "sin_precio":
      return price <= 0;
    case "sin_id":
      return !serial && !imei;
    case "sin_costo":
      return cost <= 0;
    case "en_tecnico":
      return flags.tecnico;
    case "antiguo": {
      if (!item.createdAt) return false;
      const ing = new Date(item.createdAt);
      if (Number.isNaN(ing.getTime())) return false;
      const days = Math.floor((Date.now() - ing.getTime()) / 86400000);
      return days >= 45;
    }
    default:
      return true;
  }
}

function filterInventoryForStockView(items) {
  const vf = readViewFilters("inventory");
  const q = getInvStockSearchQuery();
  const filter = getInvStockFilterValue();
  let list = items.filter(
    (item) =>
      numeric(item.stock, 0) > 0 &&
      inventoryItemMatchesSearch(item, q) &&
      inventoryItemMatchesFilter(item, filter)
  );
  if (vf.ingresoMonth === true) {
    const mk = getDashboardMonthKey();
    list = list.filter((item) => recordInMonth(item.createdAt, mk));
  }
  return list;
}

function invCardStatusClass(item) {
  if (getInvUnitFlags(item).tecnico) return "inv-unit--tec";
  if (numeric(item.price, 0) <= 0) return "inv-unit--noprice";
  return "";
}

function invUnitCardTitle(item) {
  const model = String(item.model || "").trim();
  const color = String(item.color || "").trim();
  const storage = String(item.storage || "").trim();
  const parts = [];
  if (color && color !== "Sin color") parts.push(color);
  if (storage && storage !== "Sin almacenamiento") parts.push(storage);
  if (parts.length) return parts.join(" · ");
  if (model) return model;
  return resolveInventorySerial(item) || "Equipo";
}

/** Ficha del reporte: modelo, color, almacenamiento, batería (siempre desde campos guardados). */
function invDetailDeviceSpecsHtml(item) {
  const model = String(item.model || "").trim() || "—";
  const color = String(item.color || "").trim() || "—";
  const storage = String(item.storage || "").trim() || "—";
  const bat = toBatteryLabel(item.battery);
  const batDisp = bat && bat !== "-" ? bat : "—";
  const swatch = invColorSwatchHex(item.color);
  const cells = [
    ["Modelo", model, ""],
    ["Color", color, swatch],
    ["Almacenamiento", storage, ""],
    ["Batería", batDisp, ""],
  ];
  const html = cells
    .map(
      ([k, v, dot]) =>
        `<div class="inv-device-spec"><span class="inv-device-spec__k">${escapeHtml(k)}</span><span class="inv-device-spec__v">${dot ? `<span class="inv-device-spec__dot" style="--swatch:${dot}"></span>` : ""}${escapeHtml(v)}</span></div>`
    )
    .join("");
  return `<div class="inv-device-specs" aria-label="Datos del reporte">${html}</div>`;
}

function groupBatterySummary(items) {
  const bats = items
    .map((i) => {
      const b = numeric(i.battery, NaN);
      return Number.isFinite(b) && b >= 0 && b <= 100 ? b : null;
    })
    .filter((b) => b != null);
  if (!bats.length) return "";
  const min = Math.min(...bats);
  const max = Math.max(...bats);
  return min === max ? `batería ${min}%` : `batería ${min}–${max}%`;
}

function loadInvCardsExpanded() {
  try {
    const raw = sessionStorage.getItem(`${KEYS.inventory}_cards_exp`);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (_) {
    return new Set();
  }
}

let invCardsExpanded = loadInvCardsExpanded();

function saveInvCardsExpanded() {
  try {
    sessionStorage.setItem(`${KEYS.inventory}_cards_exp`, JSON.stringify([...invCardsExpanded]));
  } catch (_) {
    /* — */
  }
}

function isInvCardExpanded(itemId) {
  return invCardsExpanded.has(String(itemId));
}

function toggleInvCardExpanded(itemId) {
  const id = String(itemId);
  if (invCardsExpanded.has(id)) invCardsExpanded.delete(id);
  else invCardsExpanded.add(id);
  saveInvCardsExpanded();
  const card = inventoryStock?.querySelector(`.inv-unit[data-id="${CSS.escape(id)}"]`);
  if (!card) {
    renderInventory();
    return;
  }
  const open = invCardsExpanded.has(id);
  card.classList.toggle("inv-tile--open", open);
  card.querySelector(".inv-card__detail, .inv-tile__detail")?.toggleAttribute("hidden", !open);
  const btn = card.querySelector('[data-action="toggle-card-expand"]');
  if (btn) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Ocultar detalle" : "Ver detalle");
  }
}

function setInvCardsExpandedForIds(ids, expanded) {
  for (const id of ids) {
    if (expanded) invCardsExpanded.add(String(id));
    else invCardsExpanded.delete(String(id));
  }
  saveInvCardsExpanded();
  renderInventory();
}

function invColorSwatchHex(color) {
  const key = String(color || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const map = {
    negro: "#18181b",
    black: "#18181b",
    blanco: "#f4f4f5",
    white: "#f4f4f5",
    azul: "#2563eb",
    blue: "#2563eb",
    rojo: "#dc2626",
    red: "#dc2626",
    verde: "#16a34a",
    green: "#16a34a",
    amarillo: "#ca8a04",
    yellow: "#ca8a04",
    morado: "#9333ea",
    purple: "#9333ea",
    rosa: "#db2777",
    pink: "#db2777",
    dorado: "#b45309",
    gold: "#b45309",
    grafito: "#52525b",
    graphite: "#52525b",
    medianoche: "#1e1b4b",
    midnight: "#1e1b4b",
    starlight: "#d6d3d1",
    plata: "#a1a1aa",
    silver: "#a1a1aa",
    space: "#3f3f46",
  };
  for (const [name, hex] of Object.entries(map)) {
    if (key.includes(name)) return hex;
  }
  return "#94a3b8";
}

function invUnitTagsHtml(item, cat, catLabel, flags) {
  const bat = toBatteryLabel(item.battery);
  const tags = [`<span class="inv-tag inv-tag--${escapeHtml(cat)}">${escapeHtml(catLabel)}</span>`];
  const color = String(item.color || "").trim();
  if (color && color !== "Sin color") {
    tags.push(`<span class="inv-tag inv-tag--color" title="Color del reporte">${escapeHtml(color)}</span>`);
  }
  if (bat && bat !== "-") {
    const pct = parseInt(String(bat).replace(/\D/g, ""), 10);
    let batCls = "inv-tag--bat-ok";
    if (!Number.isNaN(pct) && pct < 70) batCls = "inv-tag--bat-low";
    else if (!Number.isNaN(pct) && pct < 85) batCls = "inv-tag--bat-mid";
    tags.push(`<span class="inv-tag inv-tag--bat ${batCls}" title="Batería">${escapeHtml(bat)}</span>`);
  }
  if (flags.tecnico) tags.push('<span class="inv-tag inv-tag--tec" title="En técnico">Téc</span>');
  return `<div class="inv-unit__tags">${tags.join("")}</div>`;
}

function invDetailTileHtml(label, value, id, copyAction) {
  const lid = escapeHtml(label);
  if (value) {
    return `<div class="inv-dtile inv-dtile--ok">
      <div class="inv-dtile__content">
        <span class="inv-dtile__label">${lid}</span>
        <code class="inv-dtile__value">${escapeHtml(value)}</code>
        <button type="button" class="inv-dtile__action" data-action="${copyAction}" data-id="${id}">Cop.</button>
      </div>
    </div>`;
  }
  return `<div class="inv-dtile inv-dtile--miss">
    <div class="inv-dtile__content">
      <span class="inv-dtile__label">${lid}</span>
      <span class="inv-dtile__empty">Sin cargar</span>
      <button type="button" class="inv-dtile__action inv-dtile__action--fill" data-action="edit-inventory" data-id="${id}">Edit.</button>
    </div>
  </div>`;
}

function invDetailEconomyHtml(item, cost, price, summary) {
  const ingreso = formatInvIngresoDate(item.createdAt);
  if (isStaffMode()) {
    return `<div class="inv-economy-bar">
      <span class="inv-economy-bar__meta">Ingreso ${escapeHtml(ingreso)} · Precio ${escapeHtml(currency(price))}</span>
    </div>`;
  }
  if (!summary) {
    return `<div class="inv-economy-bar inv-economy-bar--muted">
      <span class="inv-economy-bar__meta">Ingreso ${escapeHtml(ingreso)} · Costo ${escapeHtml(currency(cost))} · Venta ${escapeHtml(currency(price))}</span>
      <span class="inv-economy-bar__hint">Completá costo y venta en Editar</span>
    </div>`;
  }
  const pos = summary.gainUsd > 0;
  return `<div class="inv-economy-bar${pos ? " inv-economy-bar--pos" : ""}">
    <span class="inv-economy-bar__gain">${escapeHtml(currency(summary.gainUsd))}</span>
    <span class="inv-economy-bar__meta">${escapeHtml(currency(cost))} → ${escapeHtml(currency(price))} · <strong>${summary.markupPct.toLocaleString("es-AR")}%</strong> s/costo · ${summary.marginPct.toLocaleString("es-AR")}% venta · ${escapeHtml(ingreso)}</span>
  </div>`;
}

async function persistInvUnitFlag(itemId, flag, value) {
  if (isStaffMode()) return false;
  if (flag === "online") return true;
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) return false;
  const checked = Boolean(value);
  if (flag === "tecnico") {
    const prevTecnico = item.flagTecnico === true;
    const prevVendible = item.flagVendible;
    const prevTechInAt = item.techInAt;
    item.flagTecnico = checked;
    if (checked) {
      if (!item.techInAt) item.techInAt = new Date().toISOString();
      item.flagVendible = false;
    } else {
      item.flagVendible = numeric(item.price, 0) > 0;
    }
    try {
      await persistInventoryTechFields(itemId, {
        flagTecnico: item.flagTecnico,
        flagVendible: item.flagVendible,
        techInAt: item.techInAt,
        techNotes: item.techNotes,
        techCostUsd: item.techCostUsd,
      });
      if (checked) {
        void logDeviceHistoryEvent({
          eventType: "en_tecnico",
          serial: resolveInventorySerial(item),
          imei: resolveInventoryImei(item),
          inventoryItemId: itemId,
          model: item.model,
          color: item.color,
          storage: item.storage,
          battery: item.battery ?? "",
          detail: "Marcado en técnico desde inventario",
        });
      } else {
        void logDeviceHistoryEvent({
          eventType: "salida_tecnico",
          serial: resolveInventorySerial(item),
          imei: resolveInventoryImei(item),
          inventoryItemId: itemId,
          model: item.model,
          color: item.color,
          storage: item.storage,
          battery: item.battery ?? "",
          detail: "Salida de técnico desde inventario",
        });
      }
    } catch (e) {
      item.flagTecnico = prevTecnico;
      item.flagVendible = prevVendible;
      item.techInAt = prevTechInAt;
      alert(e.message || "No se pudo guardar el estado.");
      return false;
    }
    if (invUnitModalOpenId && String(invUnitModalOpenId) === String(itemId)) {
      renderInvUnitModalContent(itemId);
    }
    renderInventory();
    renderTechService();
    return true;
  }

  const patch = invMetaFieldsForSave({
    category: item.category,
    flagTecnico: item.flagTecnico,
    flagOnline: item.flagOnline,
    flagVendible: item.flagVendible,
    price: item.price,
  });

  if (useCloud && supabaseClient) {
    try {
      const userId = await getUserId();
      const { error } = await supabaseClient
        .from("inventory_items")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", itemId)
        .eq("user_id", userId);
      if (error) throw error;
    } catch (e) {
      alert(e.message || "No se pudo guardar el estado.");
      return;
    }
  } else {
    const list = readList(KEYS.inventory);
    const idx = list.findIndex((i) => String(i.id) === String(itemId));
    if (idx >= 0) {
      Object.assign(list[idx], {
        category: patch.category,
        flagTecnico: patch.flag_tecnico,
        flagOnline: patch.flag_online,
        flagVendible: patch.flag_vendible,
      });
      writeList(KEYS.inventory, list);
    }
  }
  renderInventory();
  renderTechService();
}

function invTechDbPatch(item) {
  return {
    tech_cost_usd: numeric(item?.techCostUsd, 0),
    tech_notes: String(item?.techNotes || "").trim(),
    tech_in_at: item?.techInAt || null,
  };
}

function getTechServiceUnits() {
  return getInventory()
    .filter((item) => getInvUnitFlags(item).tecnico)
    .sort((a, b) => {
      const ta = String(a.techInAt || a.updatedAt || "");
      const tb = String(b.techInAt || b.updatedAt || "");
      return tb.localeCompare(ta);
    });
}

function getTechCashMovements() {
  return getCash().filter((c) => c.type === "egreso" && c.egresoKind === "tecnico");
}

/** Equipo ingresado por garantía (cliente devolvió unidad vendida). */
function isTechWarrantyUnit(item) {
  const notes = `${item?.techNotes || ""}\n${item?.notes || ""}`;
  return /garant[ií]a/i.test(notes);
}

function computeTechServiceStats() {
  const units = getTechServiceUnits();
  const unitCount = units.reduce((sum, i) => sum + numeric(i.stock, 0), 0);
  const repairCost = units.reduce((sum, i) => sum + numeric(i.techCostUsd, 0), 0);
  const warrantyUnits = units.filter(isTechWarrantyUnit);
  const warrantyRepairCost = warrantyUnits.reduce((sum, i) => sum + numeric(i.techCostUsd, 0), 0);
  const stockValue = units.reduce(
    (sum, i) => sum + numeric(i.stock, 0) * numeric(i.cost, 0),
    0
  );
  const cashOut = getTechCashMovements().reduce((sum, c) => sum + numeric(c.amount, 0), 0);
  return {
    units: units.length,
    unitCount,
    repairCost,
    warrantyUnits: warrantyUnits.length,
    warrantyRepairCost,
    stockValue,
    cashOut,
  };
}

function formatTechDaysInShop(techInAt) {
  if (!techInAt) return "—";
  const start = new Date(techInAt);
  if (Number.isNaN(start.getTime())) return "—";
  const days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
  if (days === 0) return "Hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}

async function persistInventoryTechFields(itemId, patch) {
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) throw new Error("Equipo no encontrado.");

  if (patch.techCostUsd != null) item.techCostUsd = numeric(patch.techCostUsd, 0);
  if (patch.techNotes != null) item.techNotes = String(patch.techNotes).trim();
  if (patch.techInAt !== undefined) item.techInAt = patch.techInAt;
  if (patch.flagTecnico != null) item.flagTecnico = patch.flagTecnico === true;
  if (patch.flagVendible != null) item.flagVendible = patch.flagVendible === true;
  if (patch.flagOnline != null) item.flagOnline = patch.flagOnline !== false;

  const meta = invMetaFieldsForSave({
    category: item.category,
    flagTecnico: item.flagTecnico,
    flagOnline: item.flagOnline,
    flagVendible: item.flagVendible,
    price: item.price,
  });
  const techDb = invTechDbPatch(item);

  if (useCloud && supabaseClient) {
    const userId = await getUserId();
    const updatedAt = new Date().toISOString();
    const { error: metaErr } = await supabaseClient
      .from("inventory_items")
      .update({ ...meta, updated_at: updatedAt })
      .eq("id", itemId)
      .eq("user_id", userId);
    if (metaErr) throw metaErr;

    const { error: techErr } = await supabaseClient
      .from("inventory_items")
      .update({ ...techDb, updated_at: updatedAt })
      .eq("id", itemId)
      .eq("user_id", userId);
    if (techErr) {
      const msg = techErr.message || "";
      if (/schema cache|could not find.*tech_|column.*tech_/i.test(msg)) {
        console.warn(
          "Campos de servicio técnico: ejecutá CRM/supabase/migration_tech_service.sql. El estado «en técnico» ya quedó guardado."
        );
      } else {
        console.warn("No se pudieron guardar notas/costos de técnico en la nube:", techErr);
      }
    }
    mirrorCloudCachesToLocal();
  } else {
    const list = readList(KEYS.inventory);
    const idx = list.findIndex((i) => String(i.id) === String(itemId));
    if (idx >= 0) {
      Object.assign(list[idx], {
        techCostUsd: item.techCostUsd,
        techNotes: item.techNotes,
        techInAt: item.techInAt,
        category: meta.category,
        flagTecnico: meta.flag_tecnico,
        flagOnline: meta.flag_online,
        flagVendible: meta.flag_vendible,
      });
      writeList(KEYS.inventory, list);
    }
  }
}

function findInventoryItemByDeviceIdentity(serial, imei) {
  const inv = getInventory();
  const ser = String(serial || "")
    .trim()
    .toUpperCase();
  const im = normalizeImeiDigits(imei);
  if (ser) {
    const hit = inv.find((i) => resolveInventorySerial(i) === ser);
    if (hit) return hit;
  }
  if (im) {
    const hit = inv.find((i) => resolveInventoryImei(i) === im);
    if (hit) return hit;
  }
  return null;
}

function isSaleInTechService(sale) {
  const id = resolveSaleDeviceIdentity(sale);
  const item = findInventoryItemByDeviceIdentity(id.serial, id.imei);
  return Boolean(item && getInvUnitFlags(item).tecnico);
}

async function setInventoryItemStock(itemId, stock) {
  const qty = Math.max(0, numeric(stock, 0));
  if (useCloud && supabaseClient) {
    const userId = await getUserId();
    const { error } = await supabaseClient
      .from("inventory_items")
      .update({ stock: qty, updated_at: new Date().toISOString() })
      .eq("id", itemId)
      .eq("user_id", userId);
    if (error) throw error;
    mirrorCloudCachesToLocal();
  } else {
    const list = readList(KEYS.inventory);
    const idx = list.findIndex((i) => String(i.id) === String(itemId));
    if (idx < 0) throw new Error("Equipo no encontrado.");
    list[idx].stock = qty;
    writeList(KEYS.inventory, list);
  }
}

/** Devolución por garantía: reingresa la unidad (por serie/IMEI) y la marca en taller sin borrar la venta. */
async function sendWarrantySaleToTech(saleId, entryNotes) {
  const sale = getSales().find((s) => String(s.id) === String(saleId));
  if (!sale) throw new Error("Venta no encontrada.");
  const devId = resolveSaleDeviceIdentity(sale);
  if (!devId.serial && !devId.imei) {
    throw new Error("Completá serie o IMEI en la venta para identificar el equipo.");
  }
  if (isSaleInTechService(sale)) {
    throw new Error("Este equipo ya está en servicio técnico.");
  }

  const clientLabel = String(sale.client || "").trim() || "cliente";
  const warrantyNote = `Garantía · venta ${sale.date || "—"} · ${clientLabel}`;
  const extra = String(entryNotes || "").trim();
  const fullNote = extra ? `${warrantyNote}\n${extra}` : warrantyNote;

  let item = findInventoryItemByDeviceIdentity(devId.serial, devId.imei);
  if (!item) {
    await saveInventoryUnitLocalOrCloud({
      model: sale.model,
      color: sale.color || "Sin color",
      storage: sale.storage || "Sin almacenamiento",
      battery: sale.battery ?? "",
      serial: devId.serial,
      imei: devId.imei,
      notes: warrantyNote,
      quantity: 1,
      price: numeric(sale.unitSale, 0) || 0,
      cost: numeric(sale.unitCost, 0),
      flagTecnico: false,
      flagOnline: false,
      flagVendible: false,
    });
    if (useCloud) {
      await refreshCloud();
      mirrorCloudCachesToLocal();
    }
    item = findInventoryItemByDeviceIdentity(devId.serial, devId.imei);
    if (!item) throw new Error("No se pudo crear la ficha en inventario.");
  } else if (numeric(item.stock, 0) <= 0) {
    await setInventoryItemStock(item.id, 1);
    if (useCloud) mirrorCloudCachesToLocal();
  }

  await markInventorySentToTech(item.id, fullNote, {
    saleId: sale.id,
    clientName: sale.client || "",
    detail: extra ? `Garantía: ${extra}` : `Ingreso por garantía — ${clientLabel}`,
  });
}

async function markInventorySentToTech(itemId, entryNotes, historyOpts = {}) {
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) throw new Error("Equipo no encontrado.");
  const note = String(entryNotes || "").trim();
  const mergedNotes = note
    ? item.techNotes
      ? `${item.techNotes}\n${note}`
      : note
    : item.techNotes || "";
  await persistInventoryTechFields(itemId, {
    flagTecnico: true,
    flagVendible: false,
    techInAt: item.techInAt || new Date().toISOString(),
    techNotes: mergedNotes,
  });
  void logDeviceHistoryEvent({
    eventType: "en_tecnico",
    serial: resolveInventorySerial(item),
    imei: resolveInventoryImei(item),
    inventoryItemId: itemId,
    saleId: historyOpts.saleId || null,
    clientName: historyOpts.clientName || "",
    model: item.model,
    color: item.color,
    storage: item.storage,
    battery: item.battery ?? "",
    detail: historyOpts.detail || note || "Ingreso a servicio técnico",
  });
}

async function releaseInventoryFromTech(itemId) {
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) throw new Error("Equipo no encontrado.");
  await persistInventoryTechFields(itemId, {
    flagTecnico: false,
    flagVendible: numeric(item.price, 0) > 0,
  });
  void logDeviceHistoryEvent({
    eventType: "salida_tecnico",
    serial: resolveInventorySerial(item),
    imei: resolveInventoryImei(item),
    inventoryItemId: itemId,
    model: item.model,
    color: item.color,
    storage: item.storage,
    battery: item.battery ?? "",
    detail: `Reparación acumulada: ${currency(numeric(item.techCostUsd, 0))}`,
  });
}

async function addTechRepairExpense({ itemId, amount, date, concept, registerCash }) {
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) throw new Error("Equipo no encontrado.");
  const amt = numeric(amount, 0);
  if (amt <= 0) throw new Error("El monto debe ser mayor a 0.");
  const conceptTrim = String(concept || "").trim();
  const serial = resolveInventorySerial(item);
  const label = [item.model, item.color, item.storage].filter(Boolean).join(" · ");
  const baseConcept = conceptTrim || `Reparación ${label}${serial ? ` (${serial})` : ""}`;
  const cashConcept =
    isTechWarrantyUnit(item) && !/^garant[ií]a/i.test(baseConcept)
      ? `Garantía · ${baseConcept}`
      : baseConcept;

  const nextCost = numeric(item.techCostUsd, 0) + amt;
  const noteLine = `${date}: ${cashConcept} — ${currency(amt)}`;
  const mergedNotes = item.techNotes ? `${item.techNotes}\n${noteLine}` : noteLine;

  await persistInventoryTechFields(itemId, {
    techCostUsd: nextCost,
    techNotes: mergedNotes,
  });

  if (registerCash) {
    if (useCloud && supabaseClient) {
      const userId = await getUserId();
      let payload = {
        user_id: userId,
        movement_type: "egreso",
        movement_date: date,
        concept: cashConcept,
        amount: amt,
        egreso_kind: "tecnico",
        reparto_dest: "tecnico",
      };
      let { error } = await supabaseClient.from("cash_movements").insert(payload);
      if (error && /reparto_dest|egreso_kind|schema cache/i.test(error.message || "")) {
        const { reparto_dest: _omitDest, egreso_kind: _omitKind, ...noMeta } = payload;
        ({ error } = await supabaseClient.from("cash_movements").insert(noMeta));
      }
      if (error) throw error;
    } else {
      const cash = readList(KEYS.cash);
      cash.unshift({
        id: crypto.randomUUID(),
        type: "egreso",
        date,
        concept: cashConcept,
        amount: amt,
        egresoKind: "tecnico",
        repartoDest: "tecnico",
      });
      writeList(KEYS.cash, cash);
    }
  }

  void logDeviceHistoryEvent({
    eventType: "actualizado",
    serial: resolveInventorySerial(item),
    imei: resolveInventoryImei(item),
    inventoryItemId: itemId,
    model: item.model,
    color: item.color,
    storage: item.storage,
    battery: item.battery ?? "",
    detail: `${isTechWarrantyUnit(item) ? "Gasto garantía" : "Gasto técnico"}: ${currency(amt)} — ${conceptTrim || cashConcept}`,
    eventAt: `${date}T12:00:00.000Z`,
  });
}

/** Ventas elegibles para taller por garantía (independiente del filtro/búsqueda de la pestaña Garantías). */
function getWarrantySalesForTechPick(includeExpired = false) {
  const sales = getSales().slice();
  return sales
    .filter((sale) => {
      const daysLeft = warrantyDaysRemaining(sale.date);
      if (!includeExpired && daysLeft < 0) return false;
      const id = resolveSaleDeviceIdentity(sale);
      if (!id.serial && !id.imei) return false;
      if (isSaleInTechService(sale)) return false;
      return true;
    })
    .sort((a, b) => {
      const da = warrantyDaysRemaining(a.date);
      const db = warrantyDaysRemaining(b.date);
      const aActive = da >= 0;
      const bActive = db >= 0;
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (aActive && bActive) return da - db;
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
}

function warrantySalesEligibleForTech() {
  return getWarrantySalesForTechPick(false);
}

function describeWarrantyPickEmptyHint(includeExpired) {
  const all = getSales();
  const vigentes = all.filter((s) => warrantyDaysRemaining(s.date) >= 0);
  const expired = all.filter((s) => warrantyDaysRemaining(s.date) < 0);
  const vigentesWithId = vigentes.filter(saleHasDeviceIdentity);
  const expiredWithId = expired.filter(saleHasDeviceIdentity);
  const inTechCount = vigentesWithId.filter((s) => isSaleInTechService(s)).length;

  if (vigentes.length === 0 && !includeExpired) {
    return "No hay ventas con garantía vigente (30 días desde la fecha de venta).";
  }
  if (vigentesWithId.length > 0 && inTechCount === vigentesWithId.length) {
    return "Las ventas vigentes con serie/IMEI ya están en servicio técnico.";
  }
  if (!includeExpired && expiredWithId.length > 0 && vigentesWithId.length === 0) {
    const sample = expiredWithId
      .slice(0, 2)
      .map((s) => `${s.client || "—"} (${s.date})`)
      .join(", ");
    return `Hay ${expiredWithId.length} venta(s) con serie/IMEI pero la garantía venció${sample ? `, ej. ${sample}` : ""}. Marcá «Incluir garantías vencidas» abajo.`;
  }
  if (vigentesWithId.length > 0) {
    return `${vigentesWithId.length} venta(s) vigente(s) tienen serie/IMEI pero no aparecen en la lista. Cerrá este cuadro, recargá con Ctrl+F5 y volvé a abrir. Si persiste, revisá que no estén ya en taller.`;
  }
  const sinId = vigentes.filter((s) => !saleHasDeviceIdentity(s)).length;
  return `Hay ${vigentes.length} venta(s) vigente(s) y ninguna tiene serie/IMEI cargado (${sinId} sin dato). En Ventas → Editar → «Serie o IMEI» → Guardar cambios.`;
}

function refreshTechWarrantyPickList() {
  if (!techWarrantyPick) return;
  const prev = techWarrantyPick.value;
  const includeExpired = document.getElementById("tech-warranty-include-expired")?.checked === true;
  const sales = getWarrantySalesForTechPick(includeExpired).slice(0, 80);

  techWarrantyPick.innerHTML =
    '<option value="">— Elegí venta con serie o IMEI —</option>' +
    sales
      .map((s) => {
        const id = resolveSaleDeviceIdentity(s);
        const unit = id.serial || id.imei || "";
        const days = warrantyDaysRemaining(s.date);
        const vig = days >= 0 ? `${days}d` : "venc.";
        const label = `${s.model} · ${s.client || "—"} · ${s.date || "—"} · ${unit} (${vig})`;
        return `<option value="${escapeHtml(String(s.id))}">${escapeHtml(label)}</option>`;
      })
      .join("");

  if (prev && [...techWarrantyPick.options].some((o) => o.value === prev)) {
    techWarrantyPick.value = prev;
  }

  if (techWarrantyPickHint) {
    if (sales.length > 0) {
      techWarrantyPickHint.hidden = true;
      techWarrantyPickHint.textContent = "";
    } else {
      techWarrantyPickHint.hidden = false;
      techWarrantyPickHint.textContent = describeWarrantyPickEmptyHint(includeExpired);
    }
  }

  const submitBtn = techWarrantyForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = sales.length === 0;
}

function prefillTechExpenseForItem(itemId) {
  if (!techExpensePick || !itemId) return;
  techExpensePick.value = itemId;
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item || !techExpenseConcept) return;
  if (isTechWarrantyUnit(item)) {
    const clientMatch = String(item.techNotes || "").match(/Garantía · venta [^·]+ · (.+)/i);
    const who = clientMatch?.[1]?.trim() || "";
    techExpenseConcept.placeholder = who
      ? `Ej: Garantía · pantalla — ${who}`
      : "Ej: Garantía · cambio de pantalla";
    if (!techExpenseConcept.value.trim()) {
      techExpenseConcept.value = "Garantía · ";
    }
  } else {
    techExpenseConcept.placeholder = "Ej: Cambio de pantalla";
    if (techExpenseConcept.value === "Garantía · ") techExpenseConcept.value = "";
  }
}

function openTechModal(modalEl) {
  if (!modalEl) return;
  for (const m of [techWarrantyModal, techSendModal, techExpenseModal]) {
    if (m && m !== modalEl && !m.hidden) closeTechModal(m);
  }
  refreshTechPickLists();
  modalEl.hidden = false;
  modalEl.setAttribute("aria-hidden", "false");
  syncBodyModalLock();
}

function closeTechModal(modalEl) {
  if (!modalEl) return;
  modalEl.hidden = true;
  modalEl.setAttribute("aria-hidden", "true");
  syncBodyModalLock();
}

function wireTechModalPanel(modalEl, backdropEl, closeEls) {
  if (!modalEl) return;
  const close = () => closeTechModal(modalEl);
  backdropEl?.addEventListener("click", close);
  closeEls.forEach((el) => el?.addEventListener("click", close));
}

async function openTechWarrantyModal() {
  if (useCloud && supabaseClient) {
    try {
      await refreshCloud();
      mirrorCloudCachesToLocal();
    } catch (_) {
      /* seguir con caché local */
    }
  }
  openTechModal(techWarrantyModal);
  refreshTechWarrantyPickList();
  if (techWarrantyPick && warrantySalesEligibleForTech().length) {
    techWarrantyPick.focus();
  } else {
    techWarrantyPickHint?.focus();
  }
}

function openTechSendModal() {
  openTechModal(techSendModal);
  techSendPick?.focus();
}

function openTechExpenseModal(itemId) {
  refreshTechPickLists();
  if (!getTechServiceUnits().length) {
    alert("No hay equipos en taller. Ingresá uno primero.");
    return;
  }
  openTechModal(techExpenseModal);
  if (itemId && techExpensePick) techExpensePick.value = itemId;
  if (techExpensePick?.value) prefillTechExpenseForItem(techExpensePick.value);
  if (techExpenseDate && !techExpenseDate.value) techExpenseDate.valueAsDate = new Date();
  techExpenseAmount?.focus();
}

function refreshTechPickLists() {
  const inv = getInventory();
  refreshTechWarrantyPickList();
  if (techSendPick) {
    const prev = techSendPick.value;
    const opts = inv
      .filter((i) => numeric(i.stock, 0) > 0 && !getInvUnitFlags(i).tecnico)
      .sort((a, b) => String(a.model || "").localeCompare(String(b.model || ""), "es"));
    techSendPick.innerHTML =
      '<option value="">— Elegí del inventario —</option>' +
      opts
        .map((i) => {
          const ser = resolveInventorySerial(i);
          const im = resolveInventoryImei(i);
          const id = ser || im ? ` · ${ser || im}` : "";
          return `<option value="${escapeHtml(String(i.id))}">${escapeHtml(
            `${i.model} · ${i.color} · ${i.storage}${id}`
          )}</option>`;
        })
        .join("");
    if (prev && [...techSendPick.options].some((o) => o.value === prev)) techSendPick.value = prev;
  }
  if (techExpensePick) {
    const prev = techExpensePick.value;
    const opts = getTechServiceUnits();
    techExpensePick.innerHTML =
      '<option value="">— Elegí equipo en técnico —</option>' +
      opts
        .map((i) => {
          const ser = resolveInventorySerial(i);
          return `<option value="${escapeHtml(String(i.id))}">${escapeHtml(
            `${i.model} · ${i.color} · ${i.storage}${ser ? ` · ${ser}` : ""}`
          )}</option>`;
        })
        .join("");
    if (prev && [...techExpensePick.options].some((o) => o.value === prev)) techExpensePick.value = prev;
  }
}

function buildTechUnitCardHtml(item) {
  const id = escapeHtml(String(item.id));
  const serial = resolveInventorySerial(item);
  const imei = resolveInventoryImei(item);
  const repair = numeric(item.techCostUsd, 0);
  const swatch = invColorSwatchHex(item.color);
  const lightSwatch = ["#f4f4f5", "#fafafa", "#e7e5e4", "#d6d3d1"].includes(swatch);
  const techNotes = String(item.techNotes || "").trim();
  const notesHtml = techNotes
    ? `<p class="tech-tile__notes">${escapeHtml(techNotes.length > 120 ? `${techNotes.slice(0, 117)}…` : techNotes)}</p>`
    : "";
  const isWarranty = isTechWarrantyUnit(item);
  const warrantyTag = isWarranty ? '<span class="tech-tile__tag">Garantía</span>' : "";
  const idLine = serial
    ? `<span class="tech-tile__id">Serie <code>${escapeHtml(serial)}</code></span>`
    : imei
      ? `<span class="tech-tile__id">IMEI <code>${escapeHtml(imei)}</code></span>`
      : "";
  return `<article class="tech-tile${isWarranty ? " tech-tile--warranty" : ""}${lightSwatch ? " tech-tile--light-swatch" : ""}" data-id="${id}">
    <div class="tech-tile__surface">
      <div class="tech-tile__top">
        <span class="tech-tile__swatch" style="--swatch:${swatch}" aria-hidden="true"></span>
        <div class="tech-tile__head-text">
          <h3 class="tech-tile__title">${escapeHtml(item.model || "Equipo")} ${warrantyTag}</h3>
          <p class="tech-tile__meta muted">${escapeHtml(item.color || "")} · ${escapeHtml(item.storage || "")}</p>
        </div>
        <span class="tech-tile__days">${escapeHtml(formatTechDaysInShop(item.techInAt))}</span>
      </div>
      ${idLine}
      <div class="tech-tile__stat">
        <span class="tech-tile__stat-k">${isWarranty ? "Gasto garantía" : "Gasto reparación"}</span>
        <strong class="tech-tile__stat-v">${escapeHtml(currency(repair))}</strong>
      </div>
      ${notesHtml}
      <div class="tech-tile__actions">
        <button type="button" class="secondary tech-tile__btn" data-tech-action="expense" data-id="${id}">Gasto</button>
        <button type="button" class="secondary tech-tile__btn" data-tech-action="view" data-id="${id}">Ficha</button>
        <button type="button" class="tech-tile__btn tech-tile__btn--done" data-tech-action="done" data-id="${id}">Listo</button>
      </div>
    </div>
  </article>`;
}

function renderTechService() {
  if (!techUnitsList) return;
  const stats = computeTechServiceStats();
  if (techKpiUnits) techKpiUnits.textContent = String(stats.units);
  if (techKpiRepairCost) techKpiRepairCost.textContent = currency(stats.repairCost);
  if (techKpiCashOut) techKpiCashOut.textContent = currency(stats.cashOut);
  if (techKpiWarrantyCost) techKpiWarrantyCost.textContent = currency(stats.warrantyRepairCost);

  refreshTechPickLists();

  const units = getTechServiceUnits();
  if (techUnitsEmpty) techUnitsEmpty.hidden = units.length > 0;
  techUnitsList.innerHTML = units.length
    ? units.map((item) => buildTechUnitCardHtml(item)).join("")
    : "";

  const moves = getTechCashMovements().slice(0, 24);
  if (techCashEmpty) techCashEmpty.hidden = moves.length > 0;
  if (techCashList) {
    techCashList.innerHTML = moves.length
      ? moves
          .map(
            (c) => `<li class="tech-cash-item">
        <span class="tech-cash-item__date">${escapeHtml(c.date || "—")}</span>
        <span class="tech-cash-item__concept">${escapeHtml(c.concept || "")}</span>
        <strong class="tech-cash-item__amt">${escapeHtml(currency(c.amount))}</strong>
      </li>`
          )
          .join("")
      : "";
  }
}

/** Ganancia y % sobre costo (markup) y sobre precio de venta (margen). */
function inventoryProfitSummary(cost, price) {
  const c = numeric(cost, 0);
  const p = numeric(price, 0);
  if (c <= 0 || p <= 0) return null;
  const gain = p - c;
  return {
    gainUsd: gain,
    markupPct: Math.round((gain / c) * 10000) / 100,
    marginPct: Math.round((gain / p) * 10000) / 100,
  };
}

function inventoryProfitPct(cost, price) {
  return inventoryProfitSummary(cost, price)?.markupPct ?? null;
}

function formatInvNotesDetailHtml(notesRaw) {
  const raw = String(notesRaw || "").trim();
  if (!raw) return "";
  const parts = raw
    .split(/\s*·\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return `<p class="inv-notes-block__text">${escapeHtml(raw)}</p>`;
  }
  const chips = parts
    .map((part) => {
      const colon = part.indexOf(":");
      if (colon > 0 && colon < 40) {
        const k = part.slice(0, colon).trim();
        const v = part.slice(colon + 1).trim();
        return `<div class="inv-note-chip"><span class="inv-note-chip__k">${escapeHtml(k)}</span><span class="inv-note-chip__v">${escapeHtml(v)}</span></div>`;
      }
      return `<div class="inv-note-chip inv-note-chip--plain"><span class="inv-note-chip__v">${escapeHtml(part)}</span></div>`;
    })
    .join("");
  return `<div class="inv-notes-block__chips">${chips}</div>`;
}

function formatInvIngresoDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Agrupa filas visibles (ya filtradas por búsqueda/filtro). */
function groupInventoryItemsForDisplay(items) {
  const inStock = items.filter((item) => numeric(item.stock, 0) > 0);
  const byModel = new Map();
  for (const item of inStock) {
    const key = inventoryModelGroupKey(item.model);
    if (!key) continue;
    const label = String(item.model || "").trim() || "Sin modelo";
    if (!byModel.has(key)) byModel.set(key, { key, label, items: [] });
    byModel.get(key).items.push(item);
  }
  const groups = [...byModel.values()];
  for (const g of groups) {
    g.items.sort((a, b) => {
      const c = String(a.color || "").localeCompare(String(b.color || ""), "es");
      if (c !== 0) return c;
      const s = String(a.storage || "").localeCompare(String(b.storage || ""), "es");
      if (s !== 0) return s;
      return String(resolveInventorySerial(a) || "").localeCompare(
        String(resolveInventorySerial(b) || ""),
        "es"
      );
    });
    g.totalUnits = g.items.reduce((sum, i) => sum + numeric(i.stock, 0), 0);
    g.totalValueUsd = g.items.reduce(
      (sum, i) => sum + numeric(i.stock, 0) * numeric(i.price, numeric(i.cost, 0)),
      0
    );
    g.batterySummary = groupBatterySummary(g.items);
  }
  groups.sort((a, b) => a.label.localeCompare(b.label, "es"));
  return groups;
}

function computeInventoryRowDisplay(item, rate) {
  const itemPrice = numeric(item.price, numeric(item.cost, 0));
  let pa =
    item.priceArs != null && Number(item.priceArs) > 0
      ? Number(item.priceArs)
      : rate > 0
        ? Math.round(numeric(itemPrice, 0) * rate)
        : null;
  const listaNum = pa != null && pa > 0 ? listaArsFromContado(pa) : null;
  const unitArs = pa != null && pa > 0 ? currencyArs(pa) : "—";
  const listaArs = listaNum != null && listaNum > 0 ? currencyArs(listaNum) : "—";
  const stockValArs = pa != null && pa > 0 ? currencyArs(item.stock * pa) : "—";

  /* Cuotas siempre sobre LISTA (contado + 10%), no sobre contado. */
  const c3 =
    listaNum != null && listaNum > 0
      ? cuotaMonthlyFromPriceArs(listaNum, 3, INV_CUOTA3_ARS_MULT)
      : null;
  const c6 =
    listaNum != null && listaNum > 0
      ? cuotaMonthlyFromPriceArs(listaNum, 6, INV_CUOTA6_ARS_MULT)
      : null;
  const c12 =
    listaNum != null && listaNum > 0
      ? cuotaMonthlyFromPriceArs(listaNum, 12, INV_CUOTA12_ARS_MULT)
      : null;
  const c18n =
    listaNum != null && listaNum > 0
      ? cuotaMonthlyFromPriceArs(listaNum, 18, INV_CUOTA18_ARS_MULT)
      : null;

  return {
    itemPrice,
    unitArs,
    listaArs,
    paNum: pa,
    listaNum,
    stockValArs,
    cuota3: c3 != null && c3 > 0 ? currencyArs(c3) : "—",
    cuota6: c6 != null && c6 > 0 ? currencyArs(c6) : "—",
    cuota12: c12 != null && c12 > 0 ? currencyArs(c12) : "—",
    cuota18: c18n != null && c18n > 0 ? currencyArs(c18n) : "—",
    cuota3Num: c3,
    cuota6Num: c6,
    cuota12Num: c12,
    cuota18Num: c18n,
  };
}

function invCuotaCountLabel(n) {
  const num = Number(n);
  return num === 1 ? "1 cuota" : `${num} cuotas`;
}

function cuotaUsdFromArsMonthly(arsNum, rate) {
  const ars = numeric(arsNum, 0);
  const r = numeric(rate, 0);
  if (ars <= 0 || r <= 0) return null;
  return ars / r;
}

function getStoreBrandLabel() {
  try {
    const cfg = typeof getCreativosConfig === "function" ? getCreativosConfig() : {};
    return String(cfg.brandName || "").trim() || "GO APPLE";
  } catch {
    return "GO APPLE";
  }
}

/** Regalos / beneficios con la compra — van en todos los mensajes WhatsApp. */
function buildPurchasePerksLines() {
  return [
    "🎁 *Con la compra te llevás:*",
    "• Funda",
    "• Templado",
    "• Cargador completo",
    "• Garantía de 30 días",
  ];
}

/** Mensaje WhatsApp listo para enviar al cliente (precios + cuotas). */
function buildClientOfferMessage(item, rate) {
  const d = computeInventoryRowDisplay(item, rate);
  const brand = getStoreBrandLabel();
  const model = String(item.model || "").trim() || "Equipo";
  const color = String(item.color || "").trim();
  const storage = String(item.storage || "").trim();
  const bat = toBatteryLabel(item.battery);
  const titleParts = [model];
  if (color && color !== "Sin color") titleParts.push(color);
  if (storage && storage !== "Sin almacenamiento") titleParts.push(storage);
  const title = titleParts.join(" · ");

  const lines = [];
  lines.push(`*${title}*`);
  if (bat && bat !== "-") lines.push(`Batería ${bat}`);
  lines.push("Disponible ahora");
  lines.push("");
  if (d.paNum > 0) lines.push(`Contado: ${d.unitArs}`);
  if (d.listaNum > 0) lines.push(`Lista (tarjeta): ${d.listaArs}`);
  if (d.itemPrice > 0) lines.push(`USD: ${currency(d.itemPrice)}`);

  const plans = [
    { n: 3, num: d.cuota3Num },
    { n: 6, num: d.cuota6Num },
    { n: 12, num: d.cuota12Num },
    { n: 18, num: d.cuota18Num },
  ].filter((p) => p.num != null && p.num > 0);

  if (plans.length) {
    lines.push("");
    lines.push(plans.map((p) => `${p.n} cuotas de ${currencyArs(p.num)}`).join("\n"));
  }

  lines.push("");
  lines.push("Incluye funda, templado, cargador y garantía 30 días.");
  lines.push("¿Lo reservamos?");
  lines.push(brand);
  return lines.join("\n");
}

function buildInvOfferMessageCardHtml(item, rate) {
  const msg = buildClientOfferMessage(item, rate);
  const id = escapeHtml(String(item.id));
  return `<section class="inv-modal-section inv-modal-card inv-modal-card--offer">
    <div class="inv-offer-head">
      <h3 class="inv-modal-section__title">Mensaje para el cliente</h3>
      <button type="button" class="inv-offer-copy-btn" data-action="copy-offer-msg" data-id="${id}">
        Copiar para WhatsApp
      </button>
    </div>
    <p class="inv-offer-hint muted">Un toque y queda listo para pegar en el chat. Incluye contado, lista (+10%) y cuotas.</p>
    <pre class="inv-offer-preview" aria-label="Vista previa del mensaje">${escapeHtml(msg)}</pre>
  </section>`;
}

const INV_WA_FIELDS_KEY = "crm-inv-wa-list-fields";
const INV_WA_DEFAULT_FIELDS = {
  color: true,
  storage: true,
  battery: true,
  usd: false,
  contado: true,
  lista: true,
  cuotas12: false,
  cuotasAll: false,
  perks: false,
  ask: false,
};

let invWaSelectMode = false;
const invWaSelectedIds = new Set();

function getInvWaFields() {
  try {
    const raw = localStorage.getItem(INV_WA_FIELDS_KEY);
    if (!raw) return { ...INV_WA_DEFAULT_FIELDS };
    return { ...INV_WA_DEFAULT_FIELDS, ...JSON.parse(raw) };
  } catch {
    return { ...INV_WA_DEFAULT_FIELDS };
  }
}

function saveInvWaFields(fields) {
  try {
    localStorage.setItem(INV_WA_FIELDS_KEY, JSON.stringify(fields));
  } catch {
    /* — */
  }
}

function readInvWaFieldsFromUi() {
  const fields = { ...INV_WA_DEFAULT_FIELDS };
  document.querySelectorAll("#inv-wa-fields-grid [data-wa-field]").forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.dataset.waField;
    if (key) fields[key] = input.checked;
  });
  if (fields.cuotasAll) fields.cuotas12 = false;
  return fields;
}

function hydrateInvWaFieldsUi() {
  const fields = getInvWaFields();
  document.querySelectorAll("#inv-wa-fields-grid [data-wa-field]").forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.dataset.waField;
    if (key && key in fields) input.checked = Boolean(fields[key]);
  });
}

function syncInvWaSelectBar() {
  const bar = document.getElementById("inv-wa-select-bar");
  const countEl = document.getElementById("inv-wa-select-count");
  const continueBtn = document.getElementById("btn-inv-wa-select-continue");
  const startBtn = document.getElementById("btn-inv-wa-list");
  if (bar) bar.hidden = !invWaSelectMode;
  if (countEl) {
    const n = invWaSelectedIds.size;
    countEl.textContent = n === 1 ? "1 seleccionado" : `${n} seleccionados`;
  }
  if (continueBtn) continueBtn.disabled = invWaSelectedIds.size === 0;
  if (startBtn) startBtn.classList.toggle("inv-wa-list-btn--active", invWaSelectMode);
  document.getElementById("tab-inventario")?.classList.toggle("inv-wa-selecting", invWaSelectMode);
}

function setInvWaSelectMode(on) {
  invWaSelectMode = Boolean(on);
  if (!invWaSelectMode) invWaSelectedIds.clear();
  syncInvWaSelectBar();
  renderInventory();
}

function toggleInvWaSelection(id) {
  const key = String(id);
  if (invWaSelectedIds.has(key)) invWaSelectedIds.delete(key);
  else invWaSelectedIds.add(key);
  syncInvWaSelectBar();
  const card = inventoryStock?.querySelector(`.inv-unit[data-id="${CSS.escape(key)}"]`);
  card?.classList.toggle("inv-unit--wa-selected", invWaSelectedIds.has(key));
  const cb = card?.querySelector(".inv-tile__wa-check");
  if (cb instanceof HTMLInputElement) cb.checked = invWaSelectedIds.has(key);
}

function selectAllVisibleInvForWa() {
  const visible = filterInventoryForStockView(getInventory());
  for (const item of visible) {
    if (numeric(item.stock, 0) > 0) invWaSelectedIds.add(String(item.id));
  }
  syncInvWaSelectBar();
  renderInventory();
}

function formatInvWaListDate() {
  return new Date().toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function buildInvWaListLine(item, fields, rate) {
  const d = computeInventoryRowDisplay(item, rate);
  const parts = [];
  const color = String(item.color || "").trim();
  const storage = String(item.storage || "").trim();
  const bat = toBatteryLabel(item.battery);
  if (fields.color && color && color !== "Sin color") parts.push(color);
  if (fields.storage && storage && storage !== "Sin almacenamiento") parts.push(storage);
  if (fields.battery && bat && bat !== "-") parts.push(bat);
  if (fields.usd && d.itemPrice > 0) parts.push(currency(d.itemPrice));
  if (fields.contado && d.paNum > 0) parts.push(`Contado ${d.unitArs}`);
  if (fields.lista && d.listaNum > 0) parts.push(`Lista ${d.listaArs}`);
  if (fields.cuotasAll) {
    const plans = [
      [3, d.cuota3Num],
      [6, d.cuota6Num],
      [12, d.cuota12Num],
      [18, d.cuota18Num],
    ].filter(([, n]) => n != null && n > 0);
    for (const [n, monthly] of plans) parts.push(`${n}x ${currencyArs(monthly)}`);
  } else if (fields.cuotas12 && d.cuota12Num > 0) {
    parts.push(`12x ${currencyArs(d.cuota12Num)}`);
  }
  if (!parts.length) {
    const title = invUnitCardTitle(item);
    return `• ${title}`;
  }
  return `• ${parts.join(" — ")}`;
}

function buildMultiInvWhatsAppList(itemIds, fields, rate) {
  const brand = getStoreBrandLabel();
  const inv = getInventory();
  const items = itemIds
    .map((id) => inv.find((i) => String(i.id) === String(id)))
    .filter((i) => i && numeric(i.stock, 0) > 0);
  items.sort((a, b) => {
    const m = String(a.model || "").localeCompare(String(b.model || ""), "es");
    if (m !== 0) return m;
    const c = String(a.color || "").localeCompare(String(b.color || ""), "es");
    if (c !== 0) return c;
    return String(a.storage || "").localeCompare(String(b.storage || ""), "es");
  });

  const byModel = new Map();
  for (const item of items) {
    const key = String(item.model || "").trim() || "Equipo";
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(item);
  }

  const lines = [];
  lines.push(`*Lista actualizada — ${formatInvWaListDate()}*`);
  lines.push(`${brand} · ${items.length} equipo${items.length === 1 ? "" : "s"} disponible${items.length === 1 ? "" : "s"}`);
  lines.push("");

  for (const [model, group] of byModel) {
    lines.push(`📱 *${model}*`);
    for (const item of group) {
      lines.push(buildInvWaListLine(item, fields, rate));
    }
    lines.push("");
  }

  lines.push("Con la compra: funda, templado, cargador y garantía 30 días.");
  lines.push("¿Cuál te reservo?");
  lines.push(`— ${brand}`);
  return { text: lines.join("\n").trim(), count: items.length };
}

function buildReadyInvWhatsAppList(itemIds, rate, fields = getInvWaFields()) {
  const brand = getStoreBrandLabel();
  const inv = getInventory();
  const items = itemIds
    .map((id) => inv.find((i) => String(i.id) === String(id)))
    .filter((i) => i && numeric(i.stock, 0) > 0);
  items.sort((a, b) => {
    const m = String(a.model || "").localeCompare(String(b.model || ""), "es");
    if (m !== 0) return m;
    const c = String(a.color || "").localeCompare(String(b.color || ""), "es");
    if (c !== 0) return c;
    return String(a.storage || "").localeCompare(String(b.storage || ""), "es");
  });

  const byModel = new Map();
  for (const item of items) {
    const key = String(item.model || "").trim() || "Equipo";
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(item);
  }

  const lines = [`*${brand}*`, formatInvWaListDate(), ""];
  for (const [model, group] of byModel) {
    lines.push(`📱 *${model}*`);
    for (const item of group) {
      const d = computeInventoryRowDisplay(item, rate);
      const bits = [];
      const color = String(item.color || "").trim();
      const storage = String(item.storage || "").trim();
      const bat = toBatteryLabel(item.battery);
      if (fields.storage && storage && storage !== "Sin almacenamiento") bits.push(storage);
      if (fields.color && color && color !== "Sin color") bits.push(color);
      if (fields.battery && bat && bat !== "-") bits.push(`🔋 ${bat}`);
      if (bits.length) lines.push(bits.join(" · "));
      const prices = [];
      if (fields.contado && d.paNum > 0) prices.push(`Contado ${d.unitArs}`);
      if (fields.lista && d.listaNum > 0) prices.push(`Lista ${d.listaArs}`);
      if (fields.usd && d.itemPrice > 0) prices.push(currency(d.itemPrice));
      if (prices.length) lines.push(`💰 ${prices.join(" · ")}`);
      if (fields.cuotasAll || fields.cuotas12) {
        const plans = fields.cuotasAll
          ? [
              [3, d.cuota3Num],
              [6, d.cuota6Num],
              [12, d.cuota12Num],
              [18, d.cuota18Num],
            ]
          : [[12, d.cuota12Num]];
        const planText = plans
          .filter(([, n]) => n != null && n > 0)
          .map(([n, monthly]) => `${n}x ${currencyArs(monthly)}`);
        if (planText.length) lines.push(planText.join(" · "));
      }
    }
    lines.push("");
  }
  if (fields.perks) lines.push("Con la compra: funda, templado, cargador y garantía 30 días.");
  if (fields.ask) lines.push("¿Cuál te reservo?");
  return { text: lines.join("\n").trim(), count: items.length };
}

let invWaPreviewAll = false;

function stockIdsForWa() {
  return getInventory()
    .filter((item) => numeric(item.stock, 0) > 0)
    .map((item) => item.id);
}

function waMessageIds() {
  if (invWaPreviewAll || invWaSelectedIds.size === 0) return stockIdsForWa();
  return [...invWaSelectedIds];
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function refreshInvWaPreview() {
  const preview = document.getElementById("inv-wa-preview");
  const meta = document.getElementById("inv-wa-preview-meta");
  if (!preview) return;
  const fields = readInvWaFieldsFromUi();
  saveInvWaFields(fields);
  const { text, count } = buildReadyInvWhatsAppList(waMessageIds(), getDolarBlueArsPerUsd(), fields);
  preview.textContent = text;
  if (meta) meta.textContent = count ? `${count} en la lista` : "Sin equipos";
}

async function copyReadyInvWhatsAppList(triggerBtn) {
  const inv = getInventory().filter((item) => numeric(item.stock, 0) > 0);
  const ids = invWaSelectedIds.size ? [...invWaSelectedIds] : inv.map((item) => item.id);
  const { text, count } = buildReadyInvWhatsAppList(ids, getDolarBlueArsPerUsd());
  if (!count) {
    alert("No hay equipos en stock para copiar.");
    return;
  }
  const ok = await copyTextToClipboard(text);
  if (!ok) {
    alert("No se pudo copiar la lista.");
    return;
  }
  if (triggerBtn instanceof HTMLElement) {
    const prev = triggerBtn.textContent;
    triggerBtn.textContent = "Lista copiada";
    setTimeout(() => {
      triggerBtn.textContent = prev;
    }, 1600);
  }
}

function openInvWaListModal(all) {
  const modal = document.getElementById("inv-wa-list-modal");
  invWaPreviewAll = Boolean(all);
  const ids = waMessageIds();
  if (!modal || !ids.length) {
    alert("No hay equipos en stock.");
    return;
  }
  hydrateInvWaFieldsUi();
  refreshInvWaPreview();
  const sub = document.getElementById("inv-wa-list-modal-sub");
  if (sub) {
    sub.textContent = invWaPreviewAll
      ? "Se guarda y la próxima copia sale así"
      : ids.length === 1
        ? "1 equipo. Se guarda para la próxima."
        : `${ids.length} equipos. Se guarda para la próxima.`;
  }
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
}

function closeInvWaListModal() {
  const modal = document.getElementById("inv-wa-list-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  invWaPreviewAll = false;
  const anyOpen = document.querySelector(".sale-modal:not([hidden])");
  document.body.classList.toggle("sale-modal-open", Boolean(anyOpen));
}

async function copyInvWaList(triggerBtn) {
  const fields = readInvWaFieldsFromUi();
  saveInvWaFields(fields);
  const { text, count } = buildReadyInvWhatsAppList(waMessageIds(), getDolarBlueArsPerUsd(), fields);
  if (!count) {
    alert("Seleccioná al menos un equipo con stock.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {
      alert("No se pudo copiar. Seleccioná el texto de la vista previa.");
      return;
    }
  }
  if (triggerBtn) {
    const prev = triggerBtn.textContent;
    triggerBtn.textContent = "¡Lista copiada!";
    triggerBtn.classList.add("inv-offer-copy-btn--ok");
    setTimeout(() => {
      triggerBtn.textContent = prev;
      triggerBtn.classList.remove("inv-offer-copy-btn--ok");
    }, 1800);
  }
}

function wireInvWaListUi() {
  if (document.body.dataset.invWaWired === "1") return;
  document.body.dataset.invWaWired = "1";

  document.getElementById("btn-inv-wa-list")?.addEventListener("click", (e) => {
    void copyReadyInvWhatsAppList(e.currentTarget);
  });
  document.getElementById("btn-inv-wa-config")?.addEventListener("click", () => {
    openInvWaListModal(true);
  });
  document.getElementById("btn-inv-wa-pick")?.addEventListener("click", () => {
    setInvWaSelectMode(!invWaSelectMode);
  });
  document.getElementById("btn-inv-wa-select-cancel")?.addEventListener("click", () => {
    setInvWaSelectMode(false);
  });
  document.getElementById("btn-inv-wa-select-clear")?.addEventListener("click", () => {
    invWaSelectedIds.clear();
    syncInvWaSelectBar();
    renderInventory();
  });
  document.getElementById("btn-inv-wa-select-visible")?.addEventListener("click", () => {
    selectAllVisibleInvForWa();
  });
  document.getElementById("btn-inv-wa-select-continue")?.addEventListener("click", () => {
    openInvWaListModal();
  });

  const closeModal = () => closeInvWaListModal();
  document.getElementById("inv-wa-list-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("inv-wa-list-modal-cancel")?.addEventListener("click", closeModal);
  document.getElementById("inv-wa-list-modal-backdrop")?.addEventListener("click", closeModal);
  document.getElementById("btn-inv-wa-copy")?.addEventListener("click", (e) => {
    void copyInvWaList(e.currentTarget);
  });
  document.getElementById("inv-wa-fields-grid")?.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.dataset.waField) return;
    if (t.dataset.waField === "cuotasAll" && t.checked) {
      const c12 = document.querySelector('#inv-wa-fields-grid [data-wa-field="cuotas12"]');
      if (c12 instanceof HTMLInputElement) c12.checked = false;
    }
    if (t.dataset.waField === "cuotas12" && t.checked) {
      const all = document.querySelector('#inv-wa-fields-grid [data-wa-field="cuotasAll"]');
      if (all instanceof HTMLInputElement) all.checked = false;
    }
    refreshInvWaPreview();
  });
}

async function copyClientOfferMessage(itemId, triggerBtn) {
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) {
    alert("Equipo no encontrado.");
    return;
  }
  const msg = buildClientOfferMessage(item, getDolarBlueArsPerUsd());
  try {
    await navigator.clipboard.writeText(msg);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = msg;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {
      alert("No se pudo copiar. Seleccioná el texto de la vista previa y copiá manualmente.");
      return;
    }
  }
  const buttons = [
    triggerBtn,
    document.getElementById("inv-unit-modal-copy-msg"),
    ...document.querySelectorAll('.inv-offer-copy-btn[data-id="' + CSS.escape(String(itemId)) + '"]'),
  ].filter(Boolean);
  for (const btn of buttons) {
    const prev = btn.dataset.prevLabel || btn.textContent;
    btn.dataset.prevLabel = prev;
    btn.textContent = "¡Copiado!";
    btn.classList.add("inv-offer-copy-btn--ok");
    setTimeout(() => {
      btn.textContent = btn.dataset.prevLabel || prev;
      btn.classList.remove("inv-offer-copy-btn--ok");
    }, 1800);
  }
}

function buildInvModalPricesHtml(item, d, rate) {
  const price = d.itemPrice;
  const contadoLine = d.unitArs !== "—" ? d.unitArs : "—";
  const listaLine = d.listaArs !== "—" ? d.listaArs : "—";
  const cost = numeric(item.cost, 0);
  const costLine = cost > 0 ? currency(cost) : "—";
  const blueHint =
    rate > 0 ? `<p class="inv-modal-prices__blue">Dólar blue ref.: ${rate.toLocaleString("es-AR")} ARS/US$</p>` : "";
  return `<section class="inv-modal-section inv-modal-card inv-modal-card--prices">
    <h3 class="inv-modal-section__title">Precio de venta</h3>
    <div class="inv-modal-prices__row inv-modal-prices__row--3">
      <div class="inv-modal-prices__block">
        <span class="inv-modal-prices__lbl">USD</span>
        <span class="inv-modal-prices__val">${escapeHtml(currency(price))}</span>
        <span class="inv-modal-prices__sub">dólares</span>
      </div>
      <div class="inv-modal-prices__block inv-modal-prices__block--accent">
        <span class="inv-modal-prices__lbl">Contado</span>
        <span class="inv-modal-prices__val">${escapeHtml(contadoLine)}</span>
        <span class="inv-modal-prices__sub">ARS efectivo</span>
      </div>
      <div class="inv-modal-prices__block inv-modal-prices__block--lista">
        <span class="inv-modal-prices__lbl">Lista</span>
        <span class="inv-modal-prices__val">${escapeHtml(listaLine)}</span>
        <span class="inv-modal-prices__sub">tarjeta · contado +10%</span>
      </div>
    </div>
    ${cost > 0 ? `<p class="inv-modal-prices__cost">Costo ${escapeHtml(costLine)} US$</p>` : ""}
    ${blueHint}
  </section>`;
}

function buildInvModalPlansHtml(d) {
  if (d.listaArs === "—" || !d.listaNum) {
    return `<section class="inv-modal-section inv-modal-card"><h3 class="inv-modal-section__title">Cuotas (sobre lista)</h3><p class="inv-modal-empty-hint">Configurá precio US$ y dólar blue para ver cuotas.</p></section>`;
  }
  const plans = [
    { n: 3, num: d.cuota3Num },
    { n: 6, num: d.cuota6Num },
    { n: 12, num: d.cuota12Num, featured: true },
    { n: 18, num: d.cuota18Num },
  ];
  const cells = plans
    .map((p) => {
      const monthly = p.num != null && p.num > 0 ? Number(p.num) : 0;
      const full = monthly > 0 ? currencyArs(monthly) : "—";
      const totalNum = monthly > 0 ? monthly * p.n : 0;
      const totalLine = totalNum > 0 ? currencyArs(totalNum) : "—";
      const feat = p.featured ? " inv-modal-plan--feat" : "";
      return `<div class="inv-modal-plan${feat}" role="listitem">
        <span class="inv-modal-plan__n">${invCuotaCountLabel(p.n)}</span>
        <span class="inv-modal-plan__ars">${escapeHtml(full)}<span class="inv-modal-plan__per">/mes</span></span>
        <span class="inv-modal-plan__total">Total ${escapeHtml(totalLine)}</span>
      </div>`;
    })
    .join("");
  return `<section class="inv-modal-section inv-modal-card">
    <h3 class="inv-modal-section__title">Cuotas mensuales · sobre lista (tarjeta)</h3>
    <p class="inv-modal-plans-hint muted">Calculadas sobre ${escapeHtml(d.listaArs)} (contado +10%).</p>
    <div class="inv-modal-plans" role="list">${cells}</div>
  </section>`;
}

function buildInvModalEconomyHtml(item, cost, price, summary, rate) {
  const ingreso = formatInvIngresoDate(item.createdAt);
  if (!summary) {
    return `<div class="inv-modal-economy inv-modal-economy--muted">
      <p class="inv-modal-economy__hint">Completá costo y precio de venta en Editar para ver ganancia.</p>
      <p class="inv-modal-economy__meta muted">Ingreso ${escapeHtml(ingreso)} · Costo ${escapeHtml(currency(cost))} · Venta ${escapeHtml(currency(price))}</p>
    </div>`;
  }
  const r = numeric(rate, 0);
  const gainArs = r > 0 ? currencyArs(summary.gainUsd * r) : null;
  return `<div class="inv-modal-economy">
    <div class="inv-modal-economy__gains">
      <div class="inv-modal-economy__gain-cell">
        <span class="inv-modal-economy__lbl">Ganancia</span>
        <span class="inv-modal-economy__val">${escapeHtml(currency(summary.gainUsd))}</span>
        <span class="inv-modal-economy__unit">US$</span>
      </div>
      ${gainArs ? `<div class="inv-modal-economy__gain-cell inv-modal-economy__gain-cell--ars">
        <span class="inv-modal-economy__lbl">Ganancia</span>
        <span class="inv-modal-economy__val">${escapeHtml(gainArs)}</span>
        <span class="inv-modal-economy__unit">ARS</span>
      </div>` : ""}
    </div>
    <p class="inv-modal-economy__meta">${escapeHtml(currency(cost))} → ${escapeHtml(currency(price))} · <strong>${summary.markupPct.toLocaleString("es-AR")}%</strong> sobre costo · <strong>${summary.marginPct.toLocaleString("es-AR")}%</strong> sobre venta · Ingreso ${escapeHtml(ingreso)}</p>
  </div>`;
}

function describeDeviceTrail(item) {
  const serial = resolveInventorySerial(item);
  const imei = resolveInventoryImei(item);
  if (!serial && !imei) {
    return "Sin serie ni IMEI. Cargalos en Editar para poder seguir este celular.";
  }
  const events = collectDeviceHistoryForQuery(serial, imei);
  const who = serial ? `Serie ${serial}` : `IMEI ${imei}`;
  if (!events.length) {
    return `${who}. Está en stock. Todavía no hay ventas ni taller registrados con ese número.`;
  }
  const last = events[0];
  const label = DEVICE_EVENT_LABELS[last.eventType] || "Movimiento";
  const when = formatDeviceHistoryWhen(last.eventAt);
  const whoClient = String(last.clientName || "").trim();
  const extra = whoClient ? ` · ${whoClient}` : "";
  return `${who}. Último: ${label}${extra} (${when}). ${events.length} movimiento${events.length === 1 ? "" : "s"}.`;
}

function buildInvUnitModalBodyHtml(item, rate) {
  const d = computeInventoryRowDisplay(item, rate);
  const serial = resolveInventorySerial(item);
  const imei = resolveInventoryImei(item);
  const notesRaw = (item.notes || "").trim();
  const flags = getInvUnitFlags(item);
  const cost = numeric(item.cost, 0);
  const price = d.itemPrice;
  const profitSummary = inventoryProfitSummary(cost, price);
  const id = escapeHtml(String(item.id));
  const swatch = invColorSwatchHex(item.color);
  const serialTile = invDetailTileHtml("Serie", serial, id, "copy-serial");
  const imeiTile = invDetailTileHtml("IMEI", imei, id, "copy-imei");
  const deviceSpecsHtml = invDetailDeviceSpecsHtml(item);
  const economyHtml = buildInvModalEconomyHtml(item, cost, price, profitSummary, rate);
  const notesBlock = notesRaw
    ? `<section class="inv-modal-section inv-modal-card"><h3 class="inv-modal-section__title">Diagnóstico 3uTools</h3><div class="inv-notes-block inv-notes-block--lite">${formatInvNotesDetailHtml(notesRaw)}</div></section>`
    : "";

  return `<p class="inv-trail">${escapeHtml(describeDeviceTrail(item))}</p>
    ${buildInvModalPricesHtml(item, d, rate)}
    ${buildInvOfferMessageCardHtml(item, rate)}
    ${buildInvModalPlansHtml(d)}
    <section class="inv-modal-section inv-modal-card">
      <h3 class="inv-modal-section__title">Características</h3>
      ${deviceSpecsHtml}
    </section>
    <section class="inv-modal-section inv-modal-card">
      <h3 class="inv-modal-section__title">Identificación</h3>
      <div class="inv-detail-grid inv-detail-grid--lite">
        ${serialTile}
        ${imeiTile}
        <label class="inv-dtile inv-dtile--tec inv-dtile--wide">
          <div class="inv-dtile__content inv-dtile__content--row">
            <span class="inv-dtile__label">En técnico</span>
            <span class="inv-tec-switch">
              <input type="checkbox" data-action="inv-flag" data-flag="tecnico" data-id="${id}" ${flags.tecnico ? "checked" : ""} />
              <span class="inv-toggle__track"></span>
            </span>
          </div>
        </label>
      </div>
      ${
        serial || imei
          ? `<p class="inv-modal-history-cta"><button type="button" class="secondary" data-action="view-device-history" data-serial="${escapeHtml(serial)}" data-imei="${escapeHtml(imei)}">Ver historial del equipo</button></p>`
          : ""
      }
    </section>
    ${
      flags.tecnico
        ? `<section class="inv-modal-section inv-modal-card">
      <h3 class="inv-modal-section__title">Servicio técnico</h3>
      <p class="inv-modal-economy__meta">En taller desde <strong>${escapeHtml(formatInvIngresoDate(item.techInAt))}</strong> · ${escapeHtml(formatTechDaysInShop(item.techInAt))}</p>
      <p class="inv-modal-economy__meta">Gasto en reparación: <strong>${escapeHtml(currency(numeric(item.techCostUsd, 0)))}</strong></p>
      ${
        (item.techNotes || "").trim()
          ? `<div class="inv-notes-block inv-notes-block--lite">${formatInvNotesDetailHtml(String(item.techNotes).trim())}</div>`
          : '<p class="muted inv-modal-empty-hint">Sin notas de taller.</p>'
      }
    </section>`
        : ""
    }
    <section class="inv-modal-section inv-modal-card">
      <h3 class="inv-modal-section__title">Rentabilidad</h3>
      ${economyHtml}
    </section>
    ${notesBlock}`;
}

function renderInvUnitModalContent(itemId) {
  if (!invUnitModalBody) return;
  const item = getInventory().find((i) => String(i.id) === String(itemId));
  if (!item) {
    invUnitModalBody.innerHTML = `<p class="muted">Equipo no encontrado.</p>`;
    return;
  }
  const rate = getDolarBlueArsPerUsd();
  const model = String(item.model || "").trim() || "Equipo";
  const title = invUnitCardTitle(item);
  if (invUnitModalTitle) invUnitModalTitle.textContent = `${model} · ${title}`;
  invUnitModalBody.innerHTML = buildInvUnitModalBodyHtml(item, rate);
}

function openInvUnitModal(itemId) {
  if (!invUnitModal) return;
  invUnitModalOpenId = String(itemId);
  renderInvUnitModalContent(itemId);
  invUnitModal.hidden = false;
  invUnitModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
}

function hideInvUnitModal() {
  if (!invUnitModal) return;
  invUnitModal.hidden = true;
  invUnitModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sale-modal-open");
  invUnitModalOpenId = null;
}

function invTileAttrsHtml(item) {
  const color = String(item.color || "").trim();
  const storage = String(item.storage || "").trim();
  const bat = toBatteryLabel(item.battery);
  const rows = [];
  if (color && color !== "Sin color") {
    rows.push(`<li><span class="inv-tile__attr-k">Color</span><span class="inv-tile__attr-v">${escapeHtml(color)}</span></li>`);
  }
  if (storage && storage !== "Sin almacenamiento") {
    rows.push(`<li><span class="inv-tile__attr-k">Almac.</span><span class="inv-tile__attr-v">${escapeHtml(storage)}</span></li>`);
  }
  if (bat && bat !== "-") {
    rows.push(`<li><span class="inv-tile__attr-k">Batería</span><span class="inv-tile__attr-v">${escapeHtml(bat)}</span></li>`);
  }
  if (!rows.length) return "";
  return `<ul class="inv-tile__attrs">${rows.join("")}</ul>`;
}

function invGroupStripSummary(group) {
  const n = group.totalUnits;
  const units = n === 1 ? "1 equipo" : `${n} equipos`;
  const prices = group.items.map((i) => numeric(i.price, 0)).filter((p) => p > 0);
  const priceBit =
    prices.length > 0
      ? prices.length === 1
        ? currency(prices[0])
        : `${currency(Math.min(...prices))} – ${currency(Math.max(...prices))}`
      : "sin precio";
  return `${units} · ${priceBit}`;
}

function buildInventoryUnitCardHtml(item, rate) {
  const d = computeInventoryRowDisplay(item, rate);
  const id = escapeHtml(String(item.id));
  const cat = normalizeInvCategory(item.category);
  const catLabel = INV_CATEGORY_LABELS[cat] || "Usado";
  const statusClass = invCardStatusClass(item);
  const title = invUnitCardTitle(item);
  const tagsHtml = invUnitTagsHtml(item, cat, catLabel, getInvUnitFlags(item));
  const swatch = invColorSwatchHex(item.color);
  const price = d.itemPrice;
  const arsContado = d.unitArs !== "—" ? d.unitArs : "";
  const arsLista = d.listaArs !== "—" ? d.listaArs : "";
  const attrsHtml = invTileAttrsHtml(item);
  const days =
    typeof window.__businessExtras?.inventoryDaysInStock === "function"
      ? window.__businessExtras.inventoryDaysInStock(item)
      : null;
  const agingBadge =
    days != null && days >= 45
      ? `<span class="inv-tag inv-tag--aging" title="Días en stock">${days}d en stock</span>`
      : days != null && days > 0
        ? `<span class="inv-tag inv-tag--days muted" title="Días en stock">${days}d</span>`
        : "";
  const lightSwatch = ["#f4f4f5", "#fafafa", "#e7e5e4", "#d6d3d1"].includes(swatch);
  const modelHint = String(item.model || "").trim();
  const modelLine =
    modelHint && title.indexOf(modelHint) < 0
      ? `<p class="inv-tile__model muted">${escapeHtml(modelHint)}</p>`
      : "";
  const arsBlock =
    arsContado && arsContado !== "—"
      ? `<span class="inv-tile__ars">${escapeHtml(arsContado)}</span><span class="inv-tile__ars-lbl">Contado</span>`
      : `<span class="inv-tile__ars inv-tile__ars--empty muted">Sin precio ARS</span>`;
  const listaBlock =
    arsLista && arsLista !== "—"
      ? `<span class="inv-tile__ars inv-tile__ars--lista">${escapeHtml(arsLista)}</span><span class="inv-tile__ars-lbl">Lista +10%</span>`
      : "";
  const selected = invWaSelectMode && invWaSelectedIds.has(String(item.id));
  const selectClass = invWaSelectMode ? " inv-unit--wa-selectable" : "";
  const selectedClass = selected ? " inv-unit--wa-selected" : "";
  const action = invWaSelectMode ? "toggle-wa-select" : "open-inv-detail";
  const aria = invWaSelectMode
    ? `${selected ? "Quitar de" : "Sumar a"} la lista: ${title}`
    : `Ver precios y cuotas de ${title}`;
  const checkHtml = invWaSelectMode
    ? `<span class="inv-tile__wa-check-wrap" aria-hidden="true">
        <input type="checkbox" class="inv-tile__wa-check" tabindex="-1" data-action="toggle-wa-select" data-id="${id}" ${selected ? "checked" : ""} />
      </span>`
    : "";

  return `
    <article class="inv-unit inv-tile ${statusClass}${lightSwatch ? " inv-unit--light-swatch" : ""}${selectClass}${selectedClass}" data-id="${id}" style="--inv-accent:${swatch}">
      ${checkHtml}
      <button type="button" class="inv-tile__surface" data-id="${id}" data-action="${action}" aria-label="${escapeHtml(aria)}">
        <div class="inv-tile__media">
          <span class="inv-unit__swatch inv-tile__swatch" style="--swatch:${swatch}" aria-hidden="true"></span>
        </div>
        <div class="inv-tile__info">
          ${modelLine}
          <h3 class="inv-tile__title">${escapeHtml(title)}</h3>
          ${attrsHtml}
          ${agingBadge}
          ${tagsHtml}
          <div class="inv-tile__prices">
            <div class="inv-tile__price-usd">
              <span class="inv-tile__usd">${escapeHtml(currency(price))}</span>
              <span class="inv-tile__usd-lbl">USD</span>
            </div>
            <div class="inv-tile__price-ars">${arsBlock}</div>
            ${listaBlock ? `<div class="inv-tile__price-lista">${listaBlock}</div>` : ""}
          </div>
          <span class="inv-tile__cta">${invWaSelectMode ? (selected ? "Seleccionado" : "Tocar para seleccionar") : "Ver precio y cuotas"}</span>
        </div>
      </button>
      ${
        invWaSelectMode
          ? ""
          : `<button type="button" class="inv-tile__wa" data-action="copy-offer-msg" data-id="${id}">Copiar WhatsApp</button>`
      }
    </article>`;
}

function renderInventory() {
  if (!inventoryStock) return;
  wireInvWaListUi();
  syncInvWaSelectBar();
  const inventory = getInventory();
  inventoryStock.innerHTML = "";
  const rate = getDolarBlueArsPerUsd();
  const visible = filterInventoryForStockView(inventory);
  const groups = groupInventoryItemsForDisplay(visible);
  const q = getInvStockSearchQuery();
  const filter = getInvStockFilterValue();

  if (groups.length === 0) {
    const msg =
      q || filter !== "all"
        ? "Ningún equipo coincide con la búsqueda o el filtro."
        : isStaffMode()
          ? "No hay equipos con stock por ahora."
          : 'No hay equipos con stock. Cargá unidades arriba o con <strong>Carga masiva</strong>.';
    inventoryStock.innerHTML = `<p class="muted inv-stock-empty">${msg}</p>`;
    return;
  }

  const filterActive = Boolean(q || filter !== "all");

  for (const group of groups) {
    const collapsed = filterActive ? false : isInvModelGroupCollapsed(group.key);
    const summary = invGroupStripSummary(group);

    const section = document.createElement("section");
    section.className = `inv-model-block${collapsed ? " inv-model-block--closed" : ""}`;
    section.dataset.modelKey = group.key;
    section.innerHTML = `
      <button
        type="button"
        class="inv-cat-row"
        data-model-key="${escapeHtml(group.key)}"
        aria-expanded="${collapsed ? "false" : "true"}"
      >
        <span class="inv-cat-row__chev" aria-hidden="true"></span>
        <span class="inv-cat-row__body">
          <span class="inv-cat-row__title">${escapeHtml(group.label)}</span>
          <span class="inv-cat-row__meta">${escapeHtml(summary)}</span>
        </span>
        <span class="inv-cat-row__hint">${collapsed ? "Ver" : "Ocultar"}</span>
      </button>
      <div class="inv-model-list" data-model-key="${escapeHtml(group.key)}" ${collapsed ? "hidden" : ""}></div>`;
    inventoryStock.appendChild(section);

    const cardsWrap = section.querySelector(".inv-model-list");
    for (const item of group.items) {
      const wrap = document.createElement("div");
      wrap.innerHTML = buildInventoryUnitCardHtml(item, rate);
      const card = wrap.firstElementChild;
      if (
        pendingAlertNav?.highlightInvId &&
        String(item.id) === String(pendingAlertNav.highlightInvId)
      ) {
        card?.classList.add("alert-row--match");
      }
      cardsWrap.appendChild(card);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CREATIVOS — Investigación, adaptación y publicación de contenido
   ═══════════════════════════════════════════════════════════════════ */

const CREATIVO_STATUSES = {
  referencia: "Referencia",
  pendiente: "Pendiente",
  copy_listo: "Copy listo",
  generado: "Generado",
  imagen_lista: "Imagen lista",
  listo: "Listo",
  publicado: "Publicado",
};

const CREATIVO_STATUS_COLORS = {
  referencia: "#94a3b8",
  pendiente: "#f59e0b",
  copy_listo: "#3b82f6",
  generado: "#8b5cf6",
  imagen_lista: "#8b5cf6",
  listo: "#22c55e",
  publicado: "#10b981",
};

function getCreativos() {
  return readList(KEYS.creativos);
}
function saveCreativos(list) {
  writeList(KEYS.creativos, list);
}
function readCreativosConfigInput(field) {
  const map = {
    notionToken: "config-notion-token",
    notionDbId: "config-notion-db-id",
    openaiKey: "config-openai-key",
    rapidapiKey: "config-rapidapi-key",
    ideogramKey: "config-ideogram-key",
    apifyToken: "config-apify-token",
    apifyHashtags: "config-apify-hashtags",
    apifyMinViews: "config-apify-min-views",
  };
  const id = map[field];
  if (!id) return "";
  return (document.getElementById(id)?.value || "").trim();
}

/** OpenAI es distinta de Ideogram/RapidAPI — resuelve localStorage, config.js y el form si aún no guardaste. */
function resolveCreativosApiKey(cfg, field, globalVar) {
  const fromCfg = (cfg?.[field] || "").trim();
  if (fromCfg) return fromCfg;
  const fromGlobal = (window[globalVar] || "").trim();
  if (fromGlobal) return fromGlobal;
  return readCreativosConfigInput(field);
}

function getCreativosConfig() {
  try {
    const raw = localStorage.getItem(KEYS.creativosConfig);
    const cfg = raw ? JSON.parse(raw) : {};
    // Always sync from config.js globals
    let changed = false;
    const g = (key, field) => {
      const val = (window[key] || "").trim();
      if (val && cfg[field] !== val) { cfg[field] = val; changed = true; }
    };
    g("APP_NOTION_TOKEN", "notionToken");
    g("APP_NOTION_DB_ID", "notionDbId");
    g("APP_OPENAI_KEY", "openaiKey");
    g("APP_RAPIDAPI_KEY", "rapidapiKey");
    g("APP_IDEOGRAM_KEY", "ideogramKey");
    g("APP_APIFY_TOKEN", "apifyToken");
    g("APP_APIFY_HASHTAGS", "apifyHashtags");
    g("APP_APIFY_MIN_VIEWS", "apifyMinViews");
    if (changed) { try { localStorage.setItem(KEYS.creativosConfig, JSON.stringify(cfg)); } catch (_) {} }
    return cfg;
  } catch (_) { return {}; }
}

function getCreativosConfigResolved() {
  const cfg = getCreativosConfig();
  return {
    ...cfg,
    notionToken: resolveCreativosApiKey(cfg, "notionToken", "APP_NOTION_TOKEN"),
    notionDbId: resolveCreativosApiKey(cfg, "notionDbId", "APP_NOTION_DB_ID"),
    openaiKey: resolveCreativosApiKey(cfg, "openaiKey", "APP_OPENAI_KEY"),
    rapidapiKey: resolveCreativosApiKey(cfg, "rapidapiKey", "APP_RAPIDAPI_KEY"),
    ideogramKey: resolveCreativosApiKey(cfg, "ideogramKey", "APP_IDEOGRAM_KEY"),
    apifyToken: resolveCreativosApiKey(cfg, "apifyToken", "APP_APIFY_TOKEN"),
    apifyHashtags: resolveCreativosApiKey(cfg, "apifyHashtags", "APP_APIFY_HASHTAGS"),
    apifyMinViews: resolveCreativosApiKey(cfg, "apifyMinViews", "APP_APIFY_MIN_VIEWS"),
  };
}

function updateCreativosOpenAIStatus() {
  const cfg = getCreativosConfigResolved();
  const ok = Boolean(cfg.openaiKey);
  const elStatus = document.getElementById("creativos-openai-status");
  if (elStatus) {
    elStatus.textContent = ok
      ? "OpenAI configurada ✓"
      : "OpenAI sin configurar — pegá tu sk-… en Configuraciones → Creativos / IA";
    elStatus.classList.toggle("creativos-openai-status--ok", ok);
    elStatus.classList.toggle("creativos-openai-status--warn", !ok);
  }
}
function saveCreativosConfig(cfg) {
  localStorage.setItem(KEYS.creativosConfig, JSON.stringify(cfg));
}

let editingCreativoId = null;

function openCreativosModal(id) {
  const modal = document.getElementById("creativos-modal");
  const backdrop = document.getElementById("creativos-modal-backdrop");
  if (!modal) return;
  editingCreativoId = id || null;
  const title = document.getElementById("creativos-modal-title");
  if (title) title.textContent = id ? "Editar creativo" : "Nuevo creativo";

  const f = document.getElementById("creativos-form");
  if (f) f.reset();
  const refPreview = document.getElementById("creativo-ref-preview");
  const resPreview = document.getElementById("creativo-result-preview");
  if (refPreview) refPreview.hidden = true;
  if (resPreview) resPreview.hidden = true;
  const aiStatus = document.getElementById("creativo-ai-status");
  if (aiStatus) aiStatus.hidden = true;

  if (id) {
    const c = getCreativos().find((x) => x.id === id);
    if (c) {
      const el = (eid) => document.getElementById(eid);
      if (el("creativo-title")) el("creativo-title").value = c.title || "";
      if (el("creativo-ref-url")) el("creativo-ref-url").value = c.refUrl || "";
      if (el("creativo-source")) el("creativo-source").value = c.source || "";
      if (el("creativo-notion-id")) el("creativo-notion-id").value = c.notionPageId || "";
      if (el("creativo-copy")) el("creativo-copy").value = c.copy || "";
      if (el("creativo-img-prompt")) el("creativo-img-prompt").value = c.imgPrompt || "";
      if (el("creativo-status")) el("creativo-status").value = c.status || "pendiente";
      if (el("creativo-pub-date")) el("creativo-pub-date").value = c.pubDate || "";
      if (el("creativo-notes")) el("creativo-notes").value = c.notes || "";
      if (c.refUrl && refPreview) {
        const img = document.getElementById("creativo-ref-preview-img");
        if (img) img.src = c.refUrl;
        refPreview.hidden = false;
      }
      if (c.resultImageUrl && resPreview) {
        const img = document.getElementById("creativo-result-img");
        if (img) img.src = c.resultImageUrl;
        resPreview.hidden = false;
      }
    }
  }
  modal.hidden = false;
  if (backdrop) backdrop.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function closeCreativosModal() {
  const modal = document.getElementById("creativos-modal");
  if (modal) { modal.hidden = true; modal.setAttribute("aria-hidden", "true"); }
  editingCreativoId = null;
}

function saveCreativoFromForm() {
  const el = (id) => document.getElementById(id);
  const title = (el("creativo-title")?.value || "").trim();
  if (!title) { alert("El título es obligatorio."); return; }

  const entry = {
    id: editingCreativoId || `cr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    refUrl: (el("creativo-ref-url")?.value || "").trim(),
    source: (el("creativo-source")?.value || "").trim(),
    notionPageId: (el("creativo-notion-id")?.value || "").trim(),
    copy: (el("creativo-copy")?.value || "").trim(),
    imgPrompt: (el("creativo-img-prompt")?.value || "").trim(),
    status: el("creativo-status")?.value || "pendiente",
    pubDate: (el("creativo-pub-date")?.value || "").trim(),
    notes: (el("creativo-notes")?.value || "").trim(),
    resultImageUrl: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const list = getCreativos();
  const idx = list.findIndex((x) => x.id === entry.id);
  if (idx >= 0) {
    entry.createdAt = list[idx].createdAt || entry.createdAt;
    entry.resultImageUrl = list[idx].resultImageUrl || "";
    list[idx] = entry;
  } else {
    list.unshift(entry);
  }
  saveCreativos(list);
  closeCreativosModal();
  renderCreativos();
  renderSectionKpis();
}

function deleteCreativo(id) {
  if (!confirm("¿Eliminar este creativo?")) return;
  deleteGeneratedImages(id);
  saveCreativos(getCreativos().filter((x) => x.id !== id));
  renderCreativos();
  renderSectionKpis();
}

/* ── Card de referencia (thumbnail + datos + procesar) ── */
function buildRefCardHtml(c) {
  const hasPost = Boolean(c.postUrl);
  const media = c.mediaUrls || [];
  const hasThumb = media.length > 0 || (c.refUrl && /^data:/.test(c.refUrl));
  const thumbSrc = media[0] || c.refUrl || "";
  const isReel = c.contentType === "reel";
  const isCarousel = c.contentType === "carousel";
  const slideCount = media.length;

  const canOpen = hasThumb || (isReel && c.videoUrl);
  let thumbHtml;
  if (hasThumb) {
    thumbHtml = `
      <div class="ref-card__thumb-wrap ref-card__open-lb" data-id="${escapeHtml(c.id)}">
        <img class="ref-card__thumb" src="${thumbSrc}" alt="" loading="lazy" />
        ${isReel ? `<span class="ref-card__play">▶</span>` : ""}
        ${isCarousel && slideCount > 1 ? `<span class="ref-card__slide-count">${slideCount} slides</span>` : ""}
      </div>`;
  } else if (isReel) {
    thumbHtml = `
      <div class="ref-card__thumb-wrap ref-card__thumb-wrap--reel ref-card__open-lb" data-id="${escapeHtml(c.id)}">
        <span class="ref-card__play">▶</span>
        <span class="ref-card__thumb-placeholder">🎬</span>
      </div>`;
  } else {
    thumbHtml = `
      <div class="ref-card__thumb-wrap ref-card__thumb-wrap--empty ref-card__open-lb" data-id="${escapeHtml(c.id)}">
        <span class="ref-card__thumb-placeholder">📷</span>
      </div>`;
  }

  const typeBadge = isCarousel ? `<span class="ref-card__type ref-card__type--carousel">🖼</span>`
    : isReel ? `<span class="ref-card__type ref-card__type--reel">🎬</span>` : "";

  return `
    <article class="ref-card ref-card__open-lb" data-id="${escapeHtml(c.id)}">
      ${thumbHtml}
      <div class="ref-card__body">
        <div class="ref-card__top-row">
          ${typeBadge}
          <h3 class="ref-card__title">${escapeHtml(c.title || c.source || "Sin nombre")}</h3>
        </div>
        <div class="ref-card__meta">
          ${hasPost ? `<a href="${escapeHtml(c.postUrl)}" target="_blank" rel="noopener" class="ref-card__link" onclick="event.stopPropagation()">Ver post ↗</a>` : ""}
          <span class="ref-card__date muted">${c.createdAt ? new Date(c.createdAt).toLocaleDateString("es-AR") : ""}</span>
        </div>
      </div>
      <button type="button" class="ref-card__del-btn" data-id="${escapeHtml(c.id)}" onclick="event.stopPropagation()">✕</button>
    </article>`;
}

/* ── Card de generado (con contenido, copy, descripción) ── */
function buildGenCardHtml(c) {
  const media = c.mediaUrls || [];
  const thumb = media[0] || c.refUrl || "";
  const igHandle = (c.postUrl || "").match(/instagram\.com\/([^\/]+)/)?.[1] || "";
  const accountName = c.source || igHandle || "";
  const contentType = c.contentType || "single";
  const isReel = contentType === "reel";

  const hasCopy = Boolean(c.copy);
  const hasImages = Boolean(c.hasGeneratedImages);
  const isPublished = c.status === "publicado";

  const stepCopy = hasCopy ? "done" : "pending";
  const stepImg = isReel ? "skip" : (hasImages ? "done" : "pending");
  const stepReady = (hasCopy && (hasImages || isReel)) ? "done" : "pending";

  let imgSection;
  if (thumb) {
    imgSection = `<div class="gen-card__thumb"><img src="${thumb}" alt="" loading="lazy" /></div>`;
  } else {
    const icon = isReel ? "🎬" : "📷";
    imgSection = `<div class="gen-card__thumb gen-card__thumb--empty"><span>${icon}</span></div>`;
  }

  const typeIcon = contentType === "carousel" ? "🖼" : isReel ? "🎬" : "📷";
  const typeLabel = contentType === "carousel" ? `Carrusel · ${media.length}` : isReel ? "Reel" : "Imagen";

  const stepIcon = (state) => state === "done" ? "✓" : state === "skip" ? "—" : "○";
  const stepClass = (state) => state === "done" ? "gen-step--done" : state === "skip" ? "gen-step--skip" : "gen-step--pending";

  return `
    <article class="gen-card" data-id="${escapeHtml(c.id)}">
      ${imgSection}
      ${hasImages ? `<div class="gen-card__overlay"><div class="gen-card__overlay-icon">✨</div></div>` : ""}
      <div class="gen-card__info">
        <div class="gen-card__header">
          <div>
            <h3 class="gen-card__title">${escapeHtml(c.title)}</h3>
            ${accountName ? `<span class="gen-card__account">@${escapeHtml(accountName)}</span>` : ""}
          </div>
          <span class="gen-card__type-pill">${typeIcon} ${typeLabel}</span>
        </div>

        <div class="gen-card__pipeline">
          <div class="gen-step ${stepClass(stepCopy)}">
            <span class="gen-step__icon">${stepIcon(stepCopy)}</span>
            <span class="gen-step__label">Copy</span>
            ${hasCopy ? `<button type="button" class="gen-step__action" data-id="${escapeHtml(c.id)}" data-action="regen-copy" title="Re-generar copy">🔄</button>` : ""}
          </div>
          <div class="gen-card__pipe-line"></div>
          <div class="gen-step ${stepClass(stepImg)}">
            <span class="gen-step__icon">${stepIcon(stepImg)}</span>
            <span class="gen-step__label">Imágenes</span>
            ${!isReel && isCreativosImageGenEnabled() ? `<button type="button" class="gen-step__action" data-id="${escapeHtml(c.id)}" data-action="regen-img" title="Re-generar imágenes">🔄</button>` : ""}
          </div>
          <div class="gen-card__pipe-line"></div>
          <div class="gen-step ${stepClass(stepReady)}">
            <span class="gen-step__icon">${stepIcon(stepReady)}</span>
            <span class="gen-step__label">${isPublished ? "Publicado" : "Listo"}</span>
          </div>
        </div>

        <div class="gen-card__footer">
          <button type="button" class="gen-card__del-btn creativos-del-btn" data-id="${escapeHtml(c.id)}" title="Eliminar">✕</button>
        </div>
      </div>
    </article>`;
}

function attachCreativoImageFromFile(creativoId, file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const list = getCreativos();
    const c = list.find((x) => x.id === creativoId);
    if (!c) return;
    c.refUrl = e.target.result;
    c.updatedAt = new Date().toISOString();
    if (c.status === "referencia") c.status = "pendiente";
    saveCreativos(list);
    renderCreativos();
    renderSectionKpis();
  };
  reader.readAsDataURL(file);
}

const CREATIVOS_REF_STATUSES = new Set(["referencia", "pendiente"]);
const CREATIVOS_GEN_STATUSES = new Set(["copy_listo", "generado", "imagen_lista", "listo", "publicado"]);

function isCreativosImageGenEnabled() {
  return window.CREATIVOS_IMAGE_GENERATION_ENABLED === true;
}

function renderCreativos() {
  const vf = readViewFilters("creativos");
  let all = getCreativos();
  if (viewLimitsToActiveMonth("creativos")) {
    const mk = getDashboardMonthKey();
    all = all.filter((c) => recordInMonth(c.createdAt, mk));
  }
  const qr = (document.getElementById("creativos-filter-q")?.value || vf.q || "").trim().toLowerCase();

  // ── Competidores panel (agrupado por source/tienda) ──
  const boardRef = document.getElementById("creativos-board-ref");
  const emptyRef = document.getElementById("creativos-empty-ref");
  if (boardRef) {
    let refs = all.filter((c) => CREATIVOS_REF_STATUSES.has(c.status));
    if (qr) refs = refs.filter((c) => [c.title, c.source, c.postUrl].filter(Boolean).join(" ").toLowerCase().includes(qr));

    const grouped = {};
    for (const c of refs) {
      const src = c.source || "Sin tienda";
      if (!grouped[src]) grouped[src] = [];
      grouped[src].push(c);
    }

    const sortedSources = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

    boardRef.innerHTML = sortedSources.map(src => {
      const items = grouped[src];
      const igHandle = (items[0].postUrl || "").match(/instagram\.com\/([^\/]+)/)?.[1] || "";
      const cardsHtml = items.map(buildRefCardHtml).join("");
      return `
        <div class="competitor-group">
          <button type="button" class="competitor-group__header" data-source="${escapeHtml(src)}">
            <div class="competitor-group__info">
              <strong class="competitor-group__name">${escapeHtml(src)}</strong>
              ${igHandle ? `<span class="competitor-group__handle">@${escapeHtml(igHandle)}</span>` : ""}
            </div>
            <span class="competitor-group__count">${items.length}</span>
            <span class="competitor-group__arrow">▾</span>
          </button>
          <div class="competitor-group__cards creativos-ref-grid">${cardsHtml}</div>
        </div>`;
    }).join("");

    if (emptyRef) emptyRef.hidden = refs.length > 0;
  }

  // ── Pipeline Kanban: Ideas → Copy → Edición → Publicación ──
  const colIdeas = all.filter((c) => CREATIVOS_REF_STATUSES.has(c.status));
  const colCopy = all.filter((c) => c.status === "copy_listo");
  const colEdicion = all.filter((c) => c.status === "generado" || c.status === "imagen_lista");
  const colPublicacion = all.filter((c) => c.status === "listo" || c.status === "publicado");

  const kanbanIdeas = document.getElementById("kanban-ideas");
  const kanbanCopy = document.getElementById("kanban-copy");
  const kanbanEdicion = document.getElementById("kanban-edicion");
  const kanbanPublicacion = document.getElementById("kanban-publicacion");

  if (kanbanIdeas) kanbanIdeas.innerHTML = colIdeas.length ? colIdeas.map(buildKanbanCardHtml).join("") : '<p class="creativos-kanban__empty">Referencias sin procesar</p>';
  if (kanbanCopy) kanbanCopy.innerHTML = colCopy.length ? colCopy.map(buildKanbanCardHtml).join("") : '<p class="creativos-kanban__empty">Arrastrá desde Ideas para generar copy</p>';
  if (kanbanEdicion) kanbanEdicion.innerHTML = colEdicion.length ? colEdicion.map(buildKanbanCardHtml).join("") : '<p class="creativos-kanban__empty">Diseñá en Canva/Figma y subí las imágenes</p>';
  if (kanbanPublicacion) kanbanPublicacion.innerHTML = colPublicacion.length ? colPublicacion.map(buildKanbanCardHtml).join("") : '<p class="creativos-kanban__empty">Listo para publicar</p>';

  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount("kanban-count-ideas", colIdeas.length);
  setCount("kanban-count-copy", colCopy.length);
  setCount("kanban-count-edicion", colEdicion.length);
  setCount("kanban-count-publicacion", colPublicacion.length);
}

const CREATIVOS_KANBAN_STAGES = new Set(["ideas", "copy", "edicion", "publicacion"]);

function getCreativoKanbanStage(c) {
  if (CREATIVOS_REF_STATUSES.has(c.status)) return "ideas";
  if (c.status === "copy_listo") return "copy";
  if (c.status === "generado" || c.status === "imagen_lista") return "edicion";
  if (c.status === "listo" || c.status === "publicado") return "publicacion";
  return "ideas";
}

function statusForKanbanStage(stage, creativo) {
  if (stage === "ideas") return "pendiente";
  if (stage === "copy") return "copy_listo";
  if (stage === "edicion") {
    return creativo?.hasGeneratedImages ? "imagen_lista" : "generado";
  }
  if (stage === "publicacion") {
    return creativo?.status === "publicado" ? "publicado" : "listo";
  }
  return creativo?.status || "pendiente";
}

async function moveCreativoToStage(creativoId, toStage, fromStage) {
  if (!CREATIVOS_KANBAN_STAGES.has(toStage)) return;

  const list = getCreativos();
  const c = list.find((x) => x.id === creativoId);
  if (!c) return;

  const prevStage = fromStage || getCreativoKanbanStage(c);

  if (toStage === "copy" && prevStage === "ideas") {
    await processCopyOnly(creativoId);
    return;
  }

  if (toStage === "edicion" && prevStage === "copy" && isCreativosImageGenEnabled() && !c.hasGeneratedImages && c.contentType !== "reel") {
    const cfg = getCreativosConfig();
    if (window.CreativosEngine && cfg.ideogramKey && c.copy) {
      await regenImagesOnly(creativoId);
      return;
    }
  }

  c.status = statusForKanbanStage(toStage, c);
  c.updatedAt = new Date().toISOString();
  saveCreativos(list);
  renderCreativos();
  renderSectionKpis();
}

function buildKanbanCardHtml(c) {
  const media = c.mediaUrls || [];
  const thumb = media[0] || c.refUrl || "";
  const contentType = c.contentType || "single";
  const isReel = contentType === "reel";
  const typeIcon = contentType === "carousel" ? "🖼" : isReel ? "🎬" : "📷";
  const stage = getCreativoKanbanStage(c);
  const copyPreview = (c.copy || "").replace(/^slide\s*\d+\s*:\s*/gim, "").trim().slice(0, 80);
  const ideaPreview = (c.ideaAngle || c.notes || "").trim().slice(0, 100);
  const previewText = copyPreview || ideaPreview;
  const hasImages = Boolean(c.hasGeneratedImages);
  const isIdea = stage === "ideas";
  const isAiIdea = Boolean(c.isAiIdea);

  return `
    <article class="kanban-card${isIdea ? " kanban-card--idea" : ""}" data-id="${escapeHtml(c.id)}" data-stage="${stage}" draggable="true">
      ${thumb ? `<div class="kanban-card__thumb"><img src="${thumb}" alt="" loading="lazy" /></div>` : `<div class="kanban-card__thumb kanban-card__thumb--empty">${typeIcon}</div>`}
      <div class="kanban-card__body">
        <h4 class="kanban-card__title">${escapeHtml(c.title || c.source || "Sin título")}</h4>
        ${previewText ? `<p class="kanban-card__preview">${escapeHtml(previewText)}${previewText.length >= 80 ? "…" : ""}</p>` : ""}
        <div class="kanban-card__meta">
          <span class="kanban-card__pill">${typeIcon}</span>
          ${isAiIdea ? '<span class="kanban-card__pill kanban-card__pill--ai-idea">💡 IA</span>' : ""}
          ${hasImages ? '<span class="kanban-card__pill kanban-card__pill--ai">✨ IA</span>' : ""}
          ${c.status === "publicado" ? '<span class="kanban-card__pill kanban-card__pill--pub">Publicado</span>' : ""}
          ${isIdea ? '<span class="kanban-card__pill kanban-card__pill--hint">→ Copy = generar</span>' : ""}
        </div>
      </div>
      ${isIdea ? `<button type="button" class="kanban-card__gen-copy" data-id="${escapeHtml(c.id)}" title="Generar copy" onclick="event.stopPropagation()">⚡ Copy</button>` : ""}
      <button type="button" class="kanban-card__del creativos-del-btn" data-id="${escapeHtml(c.id)}" title="Eliminar" onclick="event.stopPropagation()">✕</button>
    </article>`;
}

/* ── Generar ideas de contenido desde contexto (brief) ── */

async function generateContentIdeasFromContext(userContext, count, cfg) {
  const storeCtx = cfg.storeContext ? `\n\nContexto de GO APPLE:\n${cfg.storeContext}` : "";

  const invMatches = findInventoryMatchesForCreativo({ title: userContext, _transcript: userContext });
  const invContext = buildInventoryContext(invMatches);

  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            `Sos estratega de contenido para GO APPLE, tienda de iPhones en Argentina.\n` +
            `Generá exactamente ${count} ideas de posts para Instagram (carruseles, imágenes o reels).\n` +
            `Respondé SOLO JSON válido: {"ideas":[{"title":"...","angle":"...","format":"carousel|single|reel","hook":"..."}]}\n` +
            `- title: máx 8 palabras, claro\n` +
            `- angle: 1-2 oraciones, qué comunica el post\n` +
            `- format: carousel (educativo/story), single (oferta/producto), reel (hablado)\n` +
            `- hook: frase gancho opcional\n` +
            `Ideas variadas, accionables, estilo tienda real (voseo AR). No repitas el mismo ángulo.${storeCtx}`,
        },
        {
          role: "user",
          content: `Brief del usuario:\n${userContext}${invContext}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.85,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI ${resp.status}`);
  const data = await resp.json();
  let raw = (data.choices?.[0]?.message?.content || "").trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.ideas) || parsed.ideas.length === 0) {
    throw new Error("La IA no devolvió ideas válidas");
  }
  return parsed.ideas.slice(0, count);
}

function addGeneratedIdeasToWorkspace(ideas, userContext) {
  const list = getCreativos();
  const now = new Date().toISOString();
  const created = [];

  for (const idea of ideas) {
    const format = (idea.format || "carousel").toLowerCase();
    let contentType = "carousel";
    if (format === "reel") contentType = "reel";
    else if (format === "single") contentType = "single";

    const entry = {
      id: `cr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: (idea.title || "Idea de contenido").trim(),
      source: "GO APPLE · Ideas IA",
      status: "pendiente",
      contentType,
      copy: "",
      refUrl: "",
      mediaUrls: [],
      notes: `Brief: ${userContext.slice(0, 300)}`,
      ideaAngle: (idea.angle || "").trim(),
      ideaHook: (idea.hook || "").trim(),
      ideaContext: userContext.trim(),
      isAiIdea: true,
      createdAt: now,
      updatedAt: now,
    };
    list.unshift(entry);
    created.push(entry);
  }

  saveCreativos(list);
  return created;
}

async function runGenerateIdeasFromContext() {
  mergeCreativosConfigFromGlobals();
  const cfg = getCreativosConfigResolved();
  if (!cfg.openaiKey) {
    alert(
      "Falta la API Key de OpenAI (empieza con sk-…).\n\n" +
        "No es la de Ideogram ni RapidAPI.\n\n" +
        "1. Configuraciones → pestaña Creativos / IA\n" +
        "2. Campo «OpenAI API Key»\n" +
        "3. Guardar configuración\n\n" +
        "O ponela en CRM/config.js → APP_OPENAI_KEY y recargá la página."
    );
    switchTab("configuraciones");
    switchConfigSubpanel("creativos");
    document.getElementById("config-openai-key")?.focus();
    return;
  }

  const contextEl = document.getElementById("creativos-ideas-context");
  const countEl = document.getElementById("creativos-ideas-count");
  const btn = document.getElementById("btn-generate-ideas");
  const bar = document.getElementById("creativos-progress");

  const userContext = (contextEl?.value || "").trim();
  if (!userContext) {
    alert("Escribí un contexto o brief para generar ideas.");
    contextEl?.focus();
    return;
  }

  const count = Math.min(8, Math.max(1, parseInt(countEl?.value || "5", 10)));

  try {
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Generando…"; }
    if (bar) { bar.hidden = false; bar.textContent = `Generando ${count} ideas…`; }

    const ideas = await generateContentIdeasFromContext(userContext, count, cfg);
    const created = addGeneratedIdeasToWorkspace(ideas, userContext);

    try {
      localStorage.setItem("creativos_last_ideas_context", userContext);
    } catch (_) {}

    renderCreativos();
    renderSectionKpis();
    switchCreativosSubtab("workspace");

    if (bar) {
      bar.textContent = `${created.length} idea(s) agregada(s) a la columna Ideas ✓`;
      setTimeout(() => { bar.hidden = true; }, 4000);
    }
  } catch (err) {
    console.error("[IdeasGen]", err);
    if (bar) {
      bar.textContent = `Error: ${err.message}`;
      setTimeout(() => { bar.hidden = true; }, 5000);
    }
    alert(`No se pudieron generar ideas: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "✨ Generar ideas"; }
  }
}

/* ── Notion sync — estructura: Tienda (title) + Link (url) ── */
async function syncNotionCreativos() {
  const cfg = getCreativosConfig();
  if (!cfg.notionToken || !cfg.notionDbId) {
    alert("Configurá el token de Notion y el Database ID en Configuraciones → Creativos / IA.");
    return;
  }
  const bar = document.getElementById("creativos-progress");
  if (bar) { bar.hidden = false; bar.textContent = "Conectando con Notion…"; }

  try {
    const resp = await fetch(`/api/notion/v1/databases/${cfg.notionDbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100 }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      alert(`Error de Notion (${resp.status}): ${errText.slice(0, 200)}`);
      if (bar) bar.hidden = true;
      return;
    }
    const data = await resp.json();
    const existing = getCreativos();
    const existingNotionIds = new Set(existing.map((c) => c.notionPageId).filter(Boolean));
    let added = 0;

    for (const page of (data.results || [])) {
      if (existingNotionIds.has(page.id)) continue;

      const props = page.properties || {};
      const titleProp = Object.values(props).find((p) => p.type === "title");
      const storeName = titleProp?.title?.map((t) => t.plain_text).join("") || "Sin nombre";

      const urlProp = Object.values(props).find((p) => p.type === "url");
      const postUrl = urlProp?.url || "";

      const richTextProp = Object.values(props).find((p) => p.type === "rich_text");
      const richText = richTextProp?.rich_text?.map((t) => t.plain_text).join("") || "";

      const fileProp = Object.values(props).find((p) => p.type === "files");
      const fileUrl = fileProp?.files?.[0]?.file?.url || fileProp?.files?.[0]?.external?.url || "";

      const refImageUrl = fileUrl || "";

      existing.unshift({
        id: `cr_n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: storeName,
        refUrl: refImageUrl,
        postUrl: postUrl || richText,
        source: storeName,
        notionPageId: page.id,
        copy: "",
        imgPrompt: "",
        status: "referencia",
        pubDate: "",
        notes: postUrl ? `Post original: ${postUrl}` : "",
        resultImageUrl: "",
        createdAt: page.created_time || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      added++;
    }

    saveCreativos(existing);
    renderCreativos();
    renderSectionKpis();

    // Auto-download previews for new references that have a postUrl
    if (added > 0 && cfg.rapidapiKey) {
      const needPreview = existing.filter((c) => c.postUrl && (!c.mediaUrls || c.mediaUrls.length === 0));
      if (needPreview.length > 0) {
        if (bar) bar.textContent = `Descargando previews de ${needPreview.length} post(s)…`;
        await downloadRefPreviews(needPreview, cfg, bar);
      }
    }

    if (bar) { bar.textContent = added > 0 ? `${added} referencia(s) importadas.` : "Todo sincronizado, no hay nuevas."; setTimeout(() => { bar.hidden = true; }, 4000); }
  } catch (err) {
    alert(`Error al conectar con Notion: ${err.message}`);
    if (bar) bar.hidden = true;
  }
}

/* ── Reels virales de Instagram → Competidores ──
   Formato normalizado que acepta mergeViralCreativos: { owner, views, likes, comments, postUrl, title, timestamp, refUrl }.
   Se usa tanto desde el sync directo con Apify como desde el importador manual "Importar de Claude". */
function mergeViralCreativos(items) {
  const existing = getCreativos();
  const existingUrls = new Set(existing.map((c) => c.postUrl).filter(Boolean));
  let added = 0;

  for (const raw of Array.isArray(items) ? items : []) {
    const postUrl = String(raw.postUrl || raw.url || "").trim();
    if (!postUrl || existingUrls.has(postUrl)) continue;

    const views = Number(raw.views ?? raw.videoPlayCount ?? 0) || 0;
    const likesRaw = raw.likes ?? raw.likesCount;
    const hasLikes = typeof likesRaw === "number" && likesRaw >= 0;
    const comments = Number(raw.comments ?? raw.commentsCount ?? 0) || 0;
    const owner = raw.owner || raw.ownerUsername || "instagram";
    const captionLine = String(raw.title || raw.caption || "").split("\n")[0].trim();
    const title = captionLine ? captionLine.slice(0, 100) : `Reel viral @${owner}`;

    existing.unshift({
      id: `cr_ig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      refUrl: raw.displayUrl || raw.refUrl || "",
      postUrl,
      source: `@${owner} · IG viral`,
      notionPageId: "",
      copy: "",
      imgPrompt: "",
      status: "referencia",
      pubDate: "",
      notes: `👁 ${views.toLocaleString("es-AR")} reproducciones · ❤️ ${hasLikes ? likesRaw.toLocaleString("es-AR") : "oculto"} likes · 💬 ${comments.toLocaleString("es-AR")} comentarios`,
      resultImageUrl: "",
      createdAt: raw.timestamp || raw.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    added++;
    existingUrls.add(postUrl);
  }

  saveCreativos(existing);
  renderCreativos();
  renderSectionKpis();
  return { added, existing };
}

/* ── Apify sync — reels virales de Instagram del rubro (Competidores) ── */
async function syncInstagramViralesCreativos() {
  const cfg = getCreativosConfigResolved();
  if (!cfg.apifyToken) {
    alert("Configurá tu Apify API Token en Configuraciones → Creativos / IA.");
    return;
  }
  const hashtags = (cfg.apifyHashtags || "iphone, applestore, tiendaapple, ventadeiphone, iphonestore, tiendaiphone")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hashtags.length === 0) {
    alert("Agregá al menos un hashtag en Configuraciones → Creativos / IA.");
    return;
  }
  const minViews = parseInt(cfg.apifyMinViews, 10) || 300000;

  const bar = document.getElementById("creativos-progress");
  if (bar) { bar.hidden = false; bar.textContent = `Buscando reels virales en Instagram (${hashtags.length} hashtag${hashtags.length > 1 ? "s" : ""})…`; }

  try {
    const resp = await fetch(
      `/api/apify/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(cfg.apifyToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashtags, resultsType: "reels", resultsLimit: 15 }),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      alert(`Error de Apify (${resp.status}): ${errText.slice(0, 200)}`);
      if (bar) bar.hidden = true;
      return;
    }
    const items = await resp.json();
    const viral = (Array.isArray(items) ? items : [])
      .filter((it) => (it.videoPlayCount || 0) >= minViews)
      .sort((a, b) => (b.videoPlayCount || 0) - (a.videoPlayCount || 0));

    const { added, existing } = mergeViralCreativos(viral.map((it) => ({
      owner: it.ownerUsername,
      views: it.videoPlayCount || 0,
      likes: it.likesCount,
      comments: it.commentsCount || 0,
      postUrl: it.url,
      title: it.caption,
      displayUrl: it.displayUrl,
      timestamp: it.timestamp,
    })));

    // Auto-download previews para los nuevos reels (miniatura + detección de "reel")
    if (added > 0 && cfg.rapidapiKey) {
      const needPreview = existing.filter((c) => c.postUrl && (!c.mediaUrls || c.mediaUrls.length === 0));
      if (needPreview.length > 0) {
        if (bar) bar.textContent = `Descargando previews de ${needPreview.length} reel(s)…`;
        await downloadRefPreviews(needPreview, cfg, bar);
      }
    }

    if (bar) {
      bar.textContent = added > 0
        ? `${added} reel(s) viral(es) importados (+${minViews.toLocaleString("es-AR")} vistas).`
        : "No se encontraron reels nuevos por encima del mínimo de vistas.";
      setTimeout(() => { bar.hidden = true; }, 5000);
    }
  } catch (err) {
    alert(`Error al conectar con Apify: ${err.message}`);
    if (bar) bar.hidden = true;
  }
}

/* ── Importar de Claude — pegar el JSON que Claude arma en el chat ── */
function openImportClaudeModal() {
  const modal = document.getElementById("creativos-import-modal");
  if (!modal) return;
  const status = document.getElementById("creativos-import-status");
  if (status) { status.hidden = true; status.textContent = ""; status.classList.remove("creativos-openai-status--warn", "creativos-openai-status--ok"); }
  modal.hidden = false;
}

function closeImportClaudeModal() {
  const modal = document.getElementById("creativos-import-modal");
  if (modal) modal.hidden = true;
}

function runImportFromClaude() {
  const ta = document.getElementById("creativos-import-textarea");
  const status = document.getElementById("creativos-import-status");
  const raw = (ta?.value || "").trim();
  if (!raw) return;

  let items;
  try {
    items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error("tiene que ser una lista [ ]");
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.textContent = `JSON inválido: ${err.message}`;
      status.classList.add("creativos-openai-status--warn");
      status.classList.remove("creativos-openai-status--ok");
    }
    return;
  }

  const { added } = mergeViralCreativos(items);
  if (status) {
    status.hidden = false;
    status.textContent = added > 0 ? `${added} idea(s) importada(s) a Competidores.` : "No había ideas nuevas — ya estaban todas.";
    status.classList.toggle("creativos-openai-status--ok", added > 0);
    status.classList.toggle("creativos-openai-status--warn", added === 0);
  }
  if (added > 0) {
    if (ta) ta.value = "";
    setTimeout(closeImportClaudeModal, 1200);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

async function downloadRefPreviews(refs, cfg, bar) {
  const list = getCreativos();
  let processed = 0;
  for (let i = 0; i < refs.length; i++) {
    const c = refs[i];
    const entry = list.find((x) => x.id === c.id);
    if (!entry || !entry.postUrl) continue;
    if (bar) bar.textContent = `Descargando preview ${i + 1}/${refs.length}…`;

    try {
      const igData = await withTimeout(igDownloadMedia(entry.postUrl, cfg.rapidapiKey), 15000);
      const mediaList = igData.media || [];
      if (mediaList.length === 0) continue;

      const classified = classifyMedia(mediaList);
      const thumbs = [];

      if (classified.isReel) {
        entry.contentType = "reel";
        entry.videoUrl = classified.videos[0];
        for (const imgUrl of classified.images.slice(0, 1)) {
          try {
            const dl = await withTimeout(fetchMediaAsDataUri(imgUrl), 12000);
            if (dl.dataUri) thumbs.push(await resizeImageDataUri(dl.dataUri, 600));
          } catch (e) { /* skip */ }
        }
      } else if (classified.images.length > 0) {
        entry.contentType = classified.images.length > 1 ? "carousel" : "single";
        for (let j = 0; j < Math.min(classified.images.length, 10); j++) {
          try {
            const dl = await withTimeout(fetchMediaAsDataUri(classified.images[j]), 12000);
            if (dl.dataUri) thumbs.push(await resizeImageDataUri(dl.dataUri, 600));
          } catch (e) { /* skip */ }
        }
      }

      if (thumbs.length > 0) {
        entry.mediaUrls = thumbs;
        entry.refUrl = thumbs[0];
      }
      entry.updatedAt = new Date().toISOString();
      processed++;
    } catch (e) {
      console.warn(`Preview skip ${entry.postUrl}: ${e.message}`);
    }

    saveCreativos(list);
    renderCreativos();
  }
  if (bar) bar.textContent = `${processed}/${refs.length} previews descargados.`;
}

/* ══════════════════════════════════════════════════
   PIPELINE CREATIVO — Reemplaza flujo N8N completo
   Instagram → Análisis → IA → Copy + Descripción
   ══════════════════════════════════════════════════ */

/* Redimensionar imagen data URI para no saturar localStorage (~50KB cada una) */
function resizeImageDataUri(dataUri, maxW = 480) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

/* ── 1. Descargar contenido de Instagram via RapidAPI ── */
async function igDownloadMedia(postUrl, rapidapiKey) {
  const resp = await fetch(`/api/rapidapi/ig/convert?url=${encodeURIComponent(postUrl)}`, {
    headers: {
      "x-rapidapi-host": "instagram-downloader-download-instagram-stories-videos4.p.rapidapi.com",
      "x-rapidapi-key": rapidapiKey,
    },
  });
  if (!resp.ok) throw new Error(`RapidAPI ${resp.status}`);
  return resp.json();
}

/* ── 2. Descargar archivo real (media URL → base64 data URI) ── */
async function fetchMediaAsDataUri(url) {
  const resp = await fetch("/api/fetch-media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) throw new Error(`fetch-media ${resp.status}`);
  return resp.json();
}

/* ── 3. Clasificar media: imagen vs video ── */
function classifyMedia(mediaList) {
  const images = [];
  const videos = [];
  for (const m of mediaList) {
    const url = m.url || "";
    const type = (m.type || "").toLowerCase();
    if (type === "video" || /\.(mp4|mov|webm)/i.test(url)) {
      videos.push(url);
    } else if (type === "image" || /\.(jpg|jpeg|png|webp)/i.test(url)) {
      images.push(url);
    } else {
      videos.push(url);
    }
  }
  const isReel = videos.length > 0;
  const isCarousel = images.length > 1 && !isReel;
  return { images, videos, isCarousel, isReel };
}

/* ── 4. Analizar carrusel con GPT-4o-mini Vision (extraer texto de cada slide) ── */
const IMAGE_PRESETS = {
  "carousel": {
    label: "Carrusel informativo",
    promptPerSlide: (productName, headline, brand, slideIdx, totalSlides) =>
      `Apple.com official product page screenshot. ${productName} floating centered against pure #000000 black background. Product render is photorealistic with studio lighting, soft rim light on edges, subtle reflection beneath. Above the product in the upper 25% of the image, thin light-weight white text reads: "${headline}" — font is SF Pro Display Thin at 48pt, letter-spacing wide. Tiny "${brand}" in gray (#86868B) centered at very top, 12pt. Massive negative space. 1080x1080. This must look like an actual Apple.com product page. Ultra clean, ultra minimal, no decorations, no borders, no icons.`,
  },
  "promo": {
    label: "Promo / Oferta",
    promptPerSlide: (productName, headline, brand, slideIdx, totalSlides) => {
      if (slideIdx === 0) {
        return `Apple.com product launch hero image. ${productName} floating centered against pure #000000 background, photorealistic studio render with three-point lighting and rim light. Small thin white text above: "${headline}" in SF Pro Display Light 36pt. Tiny "${brand}" in #86868B at top center 12pt. Product occupies center 45% of frame. Huge negative space above and below. 1080x1080. Ultra premium, ultra minimal. No borders, no gradients, no decorations.`;
      }
      return `Apple Keynote presentation pricing slide. Pure #000000 background. Centered thin white typography: "${headline}" in SF Pro Display Light, largest text 72pt for prices, smaller 24pt for payment method labels. Tiny "${brand}" in #86868B top center. Elegant hierarchy, generous spacing between lines. 1080x1080. No product, no images, no borders, no decorations. Just premium minimal typography on black.`;
    },
  },
  "single": {
    label: "Post único",
    promptPerSlide: (productName, headline, brand, slideIdx, totalSlides) =>
      `Apple.com official product hero. ${productName} photorealistic render floating centered on pure #000000 background. Studio three-point lighting, soft rim light, subtle floor reflection. Thin white text in upper 20%: "${headline}" — SF Pro Display Light 44pt, wide letter-spacing. "${brand}" tiny in #86868B top center. 70% negative space. 1080x1080. Indistinguishable from Apple official marketing. No borders, no decorations, no icons, no extra elements.`,
  },
};

async function classifySlidePreset(imageDataUri, slideText, totalSlides, openaiKey) {
  if (totalSlides <= 1) return "single";

  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `Classify this Instagram post into ONE category. Respond ONLY with the key.

"carousel" — Informative carousel: multiple slides showing product info, features, tips, comparisons
"promo" — Promotional offer: shows a product with price, discount, payment plans, "available now"

Context (full post copy): "${(slideText || "").slice(0, 200)}"

Respond with ONLY: carousel OR promo` },
          ...(imageDataUri ? [{ type: "image_url", image_url: { url: imageDataUri, detail: "low" } }] : []),
        ],
      }],
      max_tokens: 10,
    }),
  });
  if (!resp.ok) return "carousel";
  const answer = (data => (data.choices?.[0]?.message?.content || "").trim().toLowerCase())(await resp.json());
  if (answer.includes("promo")) return "promo";
  return "carousel";
}

async function extractHeadline(slideText, presetKey, slideIdx, openaiKey) {
  const clean = stripEmojis(slideText).slice(0, 300);

  let instruction;
  if (presetKey === "promo" && slideIdx > 0) {
    instruction = `Extract ONLY the price and payment info from this text. Format: "$PRICE efectivo" or "$PRICE transferencia" or similar. If multiple prices, separate with line break. Max 4 short lines. No product names, no descriptions. Spanish.`;
  } else {
    instruction = `Write a 3-5 word headline for an Apple-style product ad from this text. Short, elegant, impactful. Include the product name and ONE key feature or storage size. No emojis. Spanish. Example: "iPhone 13. 128GB." or "Tu nuevo iPhone."`;
  }

  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `${instruction}\n\nText: "${clean}"` }],
      max_tokens: 40,
    }),
  });
  if (!resp.ok) return clean.split(/[.\n]/).filter(Boolean)[0]?.slice(0, 40) || clean.slice(0, 40);
  const data = await resp.json();
  return stripEmojis(data.choices?.[0]?.message?.content || "").replace(/^["']+|["']+$/g, "").slice(0, 60);
}

async function analyzeCarouselSlides(imageUrls, openaiKey) {
  const imageContents = imageUrls.map((url) => ({
    type: "image_url",
    image_url: { url, detail: "low" },
  }));

  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Necesito que extraigas exactamente el copy que hay en cada imagen y lo pases en limpio. Solo el texto de la imagen y ninguna otra cosa. Si hay múltiples slides, separa cada una con 'Slide N:'" },
          ...imageContents,
        ],
      }],
      max_tokens: 2000,
    }),
  });
  if (!resp.ok) throw new Error(`Vision API ${resp.status}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

/* ── 5. Transcribir video/reel con Whisper ── */
async function transcribeReel(videoDataUri, openaiKey) {
  const base64 = videoDataUri.split(",")[1] || videoDataUri;
  const resp = await fetch("/api/whisper-transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_base64: base64, api_key: openaiKey }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Whisper ${resp.status}: ${err.error || "error"}`);
  }
  const data = await resp.json();
  return (data.text || "").trim();
}

/* ── 6. System prompts profesionales (del flujo N8N) ── */

function getCarouselSystemPrompt(cfg) {
  if (cfg.copyPrompt) return cfg.copyPrompt;
  const storeCtx = cfg.storeContext ? `\n\nCONTEXTO DE LA TIENDA:\n${cfg.storeContext}` : "";
  return `ROL

Sos un guionista experto en carruseles virales de Instagram especializado EXCLUSIVAMENTE en:

– Clonado estructural de carruseles virales
– Retención slide por slide
– Hooks visuales agresivos
– Contenido real de negocios físicos
– Adaptación de referencias existentes a nuevas versiones

Tu trabajo NO es explicar.
Tu trabajo NO es ordenar demasiado.
Tu trabajo es REPRODUCIR LA EXPERIENCIA DEL CARRUSEL ORIGINAL,
adaptada a GO APPLE y respetando la estructura real de la referencia.

INSTRUCCIÓN CRÍTICA (OBLIGATORIA)

Antes de escribir, DEBÉS:

1) Analizar la referencia recibida
2) Detectar cuántos slides reales tiene
3) Detectar su estructura real, no su lógica
4) Replicar esa misma cantidad de slides
5) Mantener el tipo de progresión entre slides

IMPORTANTE:

– Si la referencia tiene 3 slides, devolvés 3 slides
– Si la referencia tiene 7 slides, devolvés 7 slides
– Si la referencia tiene 10 slides, devolvés 10 slides
– NO inventes una cantidad fija
– NO agregues slides extra
– NO resumas en menos slides

REGLAS DE CLONADO ESTRUCTURAL

El carrusel DEBE:

– Usar frases muy cortas
– Evitar párrafos largos
– Evitar explicaciones profundas
– Evitar conectores largos
– Evitar justificaciones innecesarias
– Disparar una idea y cortar
– Hacer que cada slide empuje al siguiente
– Mantener el ritmo de impacto de la referencia
– Respetar la intención de cada slide original
– Priorizar impacto sobre perfección

Cada slide debe sentirse como:
– una mini cachetada
– una opinión concreta
– una frase visual
– una razón para seguir pasando

LÓGICA DE ADAPTACIÓN

Detectar si un slide funciona como: hook, dolor, problema, comparación, solución, beneficio, oferta, urgencia, CTA.
Luego replicar ESA MISMA progresión adaptada al nuevo contenido.
No copies el texto literal. Copiá la función estructural de cada slide.

IDENTIDAD GO APPLE (OBLIGATORIA)

– Español Argentina
– Voseo
– Voz de vendedor real en el local
– Opinión sincera
– Sin tecnicismos innecesarios
– Sin tono marketinero
– Sin parecer copywriter
– Sin parecer profesor

ESTILO DE TEXTO POR SLIDE

– Texto corto, muy fácil de leer, visualmente escaneable
– Frases de 1 a 12 palabras en promedio
– No saturar

CTA: Si la referencia termina con CTA, replicá CTA. Si no, no inventes uno agresivo.

FORMATO DE RESPUESTA (OBLIGATORIO):
- Devolvé ÚNICAMENTE TEXTO PLANO. NO uses JSON, markdown, ni explicaciones.
- SIEMPRE usá el formato "Slide 1:" + texto, "Slide 2:" + texto, etc.
- Cada slide separado por una línea en blanco.
- Para promos/ofertas: Slide 1 = producto + características, Slide 2 = precio + formas de pago.
- NUNCA devuelvas el copy como un solo bloque sin separar en slides.

Ejemplo de formato correcto:

Slide 1:
iPhone 13 128GB
Batería 100% | Cargador + funda de regalo

Slide 2:
$540.000 efectivo
$550.000 transferencia | Hasta 12 cuotas

DATOS REALES: Si el usuario incluye datos de inventario (precios, stock, storage, batería), DEBÉS usar esos datos exactos. Nunca inventes precios ni capacidades. Si hay precios en el inventario, usalos tal cual aparecen.${storeCtx}`;
}

function getReelSystemPrompt(cfg) {
  if (cfg.copyPrompt) return cfg.copyPrompt;
  const storeCtx = cfg.storeContext ? `\n\nCONTEXTO DE LA TIENDA:\n${cfg.storeContext}` : "";
  return `ROL

Sos un guionista experto en contenido orgánico corto (Reels / TikTok) especializado EXCLUSIVAMENTE en:

– Clonado estructural de guiones virales
– Ritmo hablado acelerado
– Rankings caóticos que retienen atención
– Contenido real de negocios físicos

Tu trabajo NO es explicar. Tu trabajo NO es ordenar.
Tu trabajo es REPRODUCIR LA EXPERIENCIA DEL VIDEO ORIGINAL.

El guion final debe sonar: apurado, imperfecto, como alguien hablando sin pensar demasiado, casi sin pausas largas, con frases que cortan de golpe.

INSTRUCCIÓN CRÍTICA (OBLIGATORIA)

Antes de escribir, DEBÉS:
1) Analizar la transcripción de referencia
2) Detectar su ESTRUCTURA REAL, no la lógica
3) Replicar exactamente: ritmo, densidad de frases, longitud promedio por frase, tipo de cortes, forma de presentar el ranking

Si el guion suena más prolijo que el original: EL RESULTADO ES INCORRECTO

REGLAS DE CLONADO ESTRUCTURAL

El guion DEBE:
– Usar frases MUY cortas
– Evitar explicaciones
– Evitar conectores largos
– Evitar justificaciones
– Disparar opinión + cortar
– Cambiar de número sin aviso
– No respetar orden lógico tradicional
– Sonar como pensamiento hablado

IDENTIDAD GO APPLE (OBLIGATORIA)

– Español Argentina (voseo)
– Vendedor real en el local
– Opinión sincera
– Sin tecnicismos
– Sin tono marketinero

CTA: El cierre debe ser súper corto, natural, casi al pasar.

FORMATO DE SALIDA:
[GUION BASE – GO APPLE]
Texto completo del guion. Frases cortas. Ritmo rápido. Sin introducciones explicativas.${storeCtx}`;
}

function getDescriptionPrompt() {
  return "Genera una descripción para publicar en redes sociales. Debe ser llamativa y atractiva, de longitud media. En español Argentina, con emojis y hashtags relevantes. Incluí un llamado a la acción sutil para GO APPLE.";
}

/* ── 7. Generar copy con IA (usa el prompt correcto según tipo) ── */
function findInventoryMatchesForCreativo(creativo) {
  const inventory = getInventory().filter(i => i.stock > 0 && i.flagVendible);
  if (inventory.length === 0) return [];

  const title = (creativo.title || "").toLowerCase();
  const transcript = (creativo._transcript || "").toLowerCase();
  const searchText = title + " " + transcript;

  const productKeywords = ["iphone", "ipad", "macbook", "mac", "airpods", "apple watch", "watch"];
  const detectedProducts = productKeywords.filter(kw => searchText.includes(kw));

  if (detectedProducts.length === 0) return inventory.slice(0, 5);

  const matches = inventory.filter(item => {
    const model = (item.model || "").toLowerCase();
    return detectedProducts.some(kw => model.includes(kw));
  });

  return matches.slice(0, 10);
}

function buildInventoryContext(matches) {
  if (matches.length === 0) return "";

  const rate = getDolarBlueArsPerUsd();

  let ctx = "\n\n📦 INVENTARIO REAL DE GO APPLE (usá estos datos reales, NO inventes precios):\n";
  for (const item of matches) {
    const parts = [item.model];
    if (item.color) parts.push(item.color);
    if (item.storage) parts.push(item.storage);
    if (item.battery) parts.push("Batería " + item.battery + "%");
    parts.push("Stock: " + item.stock);

    let arsPrice = Number(item.priceArs || 0);
    if (!arsPrice && item.price && rate) {
      arsPrice = Math.round(Number(item.price) * rate);
    }

    const listaPrice = arsPrice > 0 ? listaArsFromContado(arsPrice) : 0;
    if (arsPrice > 0) {
      parts.push("CONTADO: $" + arsPrice.toLocaleString("es-AR"));
      parts.push("LISTA/TARJETA: $" + listaPrice.toLocaleString("es-AR") + " (contado +10%)");
    } else if (item.price && Number(item.price) > 0) {
      parts.push("PRECIO USD: $" + Number(item.price));
    }

    const cuota3 =
      listaPrice > 0 ? cuotaMonthlyFromPriceArs(listaPrice, 3, INV_CUOTA3_ARS_MULT) : 0;
    const cuota6 =
      listaPrice > 0 ? cuotaMonthlyFromPriceArs(listaPrice, 6, INV_CUOTA6_ARS_MULT) : 0;
    const cuota12 =
      listaPrice > 0 ? cuotaMonthlyFromPriceArs(listaPrice, 12, INV_CUOTA12_ARS_MULT) : 0;

    if (cuota3) parts.push("3 cuotas (sobre lista): $" + cuota3.toLocaleString("es-AR"));
    if (cuota6) parts.push("6 cuotas (sobre lista): $" + cuota6.toLocaleString("es-AR"));
    if (cuota12) parts.push("12 cuotas (sobre lista): $" + cuota12.toLocaleString("es-AR"));

    ctx += "- " + parts.join(" | ") + "\n";
  }
  ctx += "\n⚠️ REGLA ABSOLUTA DE PRECIOS:\n";
  ctx += "- REEMPLAZÁ cualquier precio que venga de la referencia original con los precios del inventario de arriba.\n";
  ctx += "- Los precios de la referencia son de OTRA tienda, NO son de GO APPLE.\n";
  ctx += "- Usá ÚNICAMENTE los precios listados arriba. NUNCA copies precios de la referencia.\n";
  ctx += "- Si el inventario dice $639.000, usá $639.000. NO uses un precio diferente.\n";
  ctx += "- Incluí las cuotas reales del inventario, no inventes planes de cuotas.\n";
  return ctx;
}

async function aiGenerateCopyForCreativo(cfg, creativo) {
  const isReel = creativo._contentType === "reel";
  const systemPrompt = isReel ? getReelSystemPrompt(cfg) : getCarouselSystemPrompt(cfg);
  const transcript = creativo._transcript || "";

  const refSlideCount = (creativo.mediaUrls || []).length || 1;

  const invMatches = findInventoryMatchesForCreativo(creativo);
  const invContext = buildInventoryContext(invMatches);
  console.log("[CopyGen] Inventario matches:", invMatches.length, "| Slides referencia:", refSlideCount);
  if (invContext) console.log("[CopyGen] Contexto inventario:", invContext);

  let userMsg;
  if (transcript) {
    userMsg = transcript + invContext;
  } else {
    userMsg = `Generá un copy para Instagram para GO APPLE basado en la ESTRUCTURA de este creativo de otra tienda.\n\n` +
      `Tienda original: ${creativo.source || "—"}\n` +
      `Referencia: ${creativo.title}\n` +
      (creativo.postUrl ? `Post original: ${creativo.postUrl}\n` : "") +
      `\nLA REFERENCIA TIENE EXACTAMENTE ${refSlideCount} SLIDES. Devolvé EXACTAMENTE ${refSlideCount} slides, ni más ni menos.` +
      invContext +
      `\nAdaptalo a GO APPLE. Copy listo para publicar.`;
  }

  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}`);
  const data = await resp.json();
  let rawCopy = (data.choices?.[0]?.message?.content || "").trim();

  rawCopy = postProcessCopy(rawCopy, refSlideCount, invMatches);
  return rawCopy;
}

function postProcessCopy(rawCopy, targetSlideCount, invMatches) {
  if (invMatches.length > 0) {
    rawCopy = replaceWithInventoryPrices(rawCopy, invMatches);
  }

  if (!/^slide\s*\d+\s*:/im.test(rawCopy)) {
    rawCopy = autoFormatCopyIntoSlides(rawCopy, targetSlideCount);
  } else {
    rawCopy = limitSlideCount(rawCopy, targetSlideCount);
  }

  return rawCopy;
}

function replaceWithInventoryPrices(copy, invMatches) {
  const rate = getDolarBlueArsPerUsd();
  const bestMatch = invMatches[0];
  if (!bestMatch) return copy;

  let arsPrice = Number(bestMatch.priceArs || 0);
  if (!arsPrice && bestMatch.price && rate) {
    arsPrice = Math.round(Number(bestMatch.price) * rate);
  }
  if (!arsPrice) return copy;

  const formatted = "$" + arsPrice.toLocaleString("es-AR");

  copy = copy.replace(/\$[\d.,]+\s*(efectivo|en\s+efectivo|contado)/gi, formatted + " efectivo");
  copy = copy.replace(/\$[\d.,]+\s*(transfer\w*|por\s+transfer\w*)/gi, formatted + " transferencia");
  copy = copy.replace(/\$[\d.,]+(?!\s*(efectivo|transfer|cuota|mes))/gi, formatted);

  return copy;
}

function limitSlideCount(rawCopy, target) {
  const parts = rawCopy.split(/(?=^slide\s*\d+\s*:)/im).filter(s => s.trim());
  if (parts.length <= target) return rawCopy;
  return parts.slice(0, target).join("\n\n").trim();
}

function autoFormatCopyIntoSlides(rawCopy, targetSlideCount) {
  const lines = rawCopy.split(/\n/).map(l => l.trim()).filter(Boolean);

  if (targetSlideCount <= 2) {
    const priceLines = [];
    const productLines = [];

    for (const line of lines) {
      if (/\$[\d.,]+/.test(line) || /cuotas?/i.test(line) || /efectivo|transfer/i.test(line) || /escribi|manda|consult|contact|mensaje/i.test(line)) {
        priceLines.push(line);
      } else {
        productLines.push(line);
      }
    }

    if (priceLines.length > 0 && productLines.length > 0 && targetSlideCount >= 2) {
      return "Slide 1:\n" + productLines.join("\n") + "\n\nSlide 2:\n" + priceLines.join("\n");
    }
    return "Slide 1:\n" + lines.join("\n");
  }

  const perSlide = Math.ceil(lines.length / targetSlideCount);
  const parts = [];
  for (let i = 0; i < lines.length; i += perSlide) {
    const chunk = lines.slice(i, i + perSlide);
    parts.push("Slide " + (parts.length + 1) + ":\n" + chunk.join("\n"));
    if (parts.length >= targetSlideCount) break;
  }
  return parts.join("\n\n");
}

/* ── 8. Generar título corto ── */
async function aiGenerateTitle(cfg, copyText) {
  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: `Genera un titulo corto (máximo 8 palabras) para identificar este contenido, basado en lo que trata:\n\n${copyText}` },
      ],
      max_tokens: 50,
      temperature: 0.7,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI title ${resp.status}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

/* ── 9. Generar descripción para redes ── */
async function aiGenerateDescription(cfg, copyText) {
  const resp = await fetch("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: getDescriptionPrompt() },
        { role: "user", content: copyText },
      ],
      max_tokens: 500,
      temperature: 0.8,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI desc ${resp.status}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

/* ── 10. Generar imagen con DALL-E ── */
async function aiGenerateImageForCreativo(cfg, creativo) {
  const promptMsg = `Create a professional Instagram post image for GO APPLE, an iPhone store in Argentina. ` +
    `The post is about: ${creativo.title}. ` +
    `Style: modern, clean background, product photography style, green brand accent color (#22c55e). ` +
    `The image should look like a polished social media ad for an Apple products store. ` +
    `Include subtle brand elements. Square format (1080x1080). No text in the image.`;

  const resp = await fetch("/api/openai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt: creativo.imgPrompt || promptMsg,
      n: 1,
      size: "1024x1024",
      quality: "standard",
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DALL-E ${resp.status}: ${errText.slice(0, 150)}`);
  }
  const data = await resp.json();
  return data.data?.[0]?.url || "";
}

/* ══════════════════════════════════════════════════
   PIPELINE COMPLETO: Procesar un creativo de punta a punta
   (Reemplaza todo el flujo N8N)
   ══════════════════════════════════════════════════ */
async function ensureCreativoReferenceMedia(c, cfg, progressCb) {
  const log = (msg) => progressCb && progressCb(msg);
  if (!c.mediaUrls) c.mediaUrls = [];

  if (!c.postUrl || !cfg.rapidapiKey) return;
  if (c.mediaUrls.length > 0 && c.transcript) return;

  log("Descargando contenido de Instagram…");
  try {
    const igData = await igDownloadMedia(c.postUrl, cfg.rapidapiKey);
    const mediaList = igData.media || [];

    if (mediaList.length > 0) {
      const classified = classifyMedia(mediaList);

      if (classified.isCarousel || classified.images.length > 0) {
        c.contentType = "carousel";
        const fullUris = [];
        for (let i = 0; i < Math.min(classified.images.length, 10); i++) {
          log(`Descargando slide ${i + 1}/${classified.images.length}…`);
          try {
            const dl = await fetchMediaAsDataUri(classified.images[i]);
            if (dl.dataUri) {
              const resized = await resizeImageDataUri(dl.dataUri, 600);
              fullUris.push(resized);
            }
          } catch (e) { /* skip */ }
        }
        c.mediaUrls = fullUris;
        if (fullUris.length > 0) c.refUrl = fullUris[0];

        log("Analizando texto de los slides (GPT Vision)…");
        if (fullUris.length > 0 && cfg.openaiKey) {
          try {
            c.transcript = await analyzeCarouselSlides(fullUris, cfg.openaiKey);
            c._transcript = c.transcript;
          } catch (e) {
            c.transcript = "";
          }
        }
      } else if (classified.isReel || classified.videos.length > 0) {
        c.contentType = "reel";
        if (classified.images.length > 0) {
          try {
            const thumbDl = await fetchMediaAsDataUri(classified.images[0]);
            if (thumbDl.dataUri) {
              const resized = await resizeImageDataUri(thumbDl.dataUri, 600);
              c.refUrl = resized;
              c.mediaUrls = [resized];
            }
          } catch (e) { /* no thumb */ }
        }
        c.videoUrl = classified.videos[0];
        log("Descargando reel…");
        try {
          const videoDl = await fetchMediaAsDataUri(classified.videos[0]);
          if (videoDl.dataUri) {
            log("Transcribiendo reel (Whisper)…");
            c.transcript = await transcribeReel(videoDl.dataUri, cfg.openaiKey);
            c._transcript = c.transcript;
          }
        } catch (e) {
          c.notes = (c.notes ? c.notes + " | " : "") + `Whisper: ${e.message}`;
        }
      }
    }
  } catch (err) {
    c.notes = (c.notes ? c.notes + " | " : "") + `IG download: ${err.message}`;
  }
}

async function processCopyOnly(creativoId) {
  const cfg = getCreativosConfig();
  if (!cfg.openaiKey) {
    alert("Configurá la API Key de OpenAI en Configuraciones → Creativos / IA.");
    return;
  }
  const list = getCreativos();
  const c = list.find((x) => x.id === creativoId);
  if (!c) return;

  const bar = document.getElementById("creativos-progress");
  const log = (msg) => { if (bar) { bar.hidden = false; bar.textContent = msg; } };

  document.querySelector(`.kanban-card[data-id="${creativoId}"]`)?.classList.add("kanban-card--loading");

  try {
    await ensureCreativoReferenceMedia(c, cfg, log);

    log("Generando copy con IA…");
    c._contentType = c.contentType;
    c._transcript = c.transcript || [c.ideaAngle, c.ideaHook, c.ideaContext].filter(Boolean).join("\n\n");
    c.copy = await aiGenerateCopyForCreativo(cfg, c);

    log("Generando título…");
    try {
      const title = await aiGenerateTitle(cfg, c.copy);
      if (title) c.title = title;
    } catch (e) { /* keep */ }

    log("Generando descripción…");
    try {
      const desc = await aiGenerateDescription(cfg, c.copy);
      if (desc) c.description = desc;
    } catch (e) { /* keep */ }

    delete c._contentType;
    delete c._transcript;
    c.status = "copy_listo";
    c.updatedAt = new Date().toISOString();

    saveCreativos(list);
    renderCreativos();
    renderSectionKpis();
    switchCreativosSubtab("workspace");
    log("Copy generado ✓");
    setTimeout(() => { if (bar) bar.hidden = true; }, 3000);
  } catch (err) {
    log(`❌ Error: ${err.message}`);
    setTimeout(() => { if (bar) bar.hidden = true; }, 5000);
  } finally {
    document.querySelector(`.kanban-card[data-id="${creativoId}"]`)?.classList.remove("kanban-card--loading");
  }
}

async function fullPipelineCreativo(c, cfg, progressCb) {
  const log = (msg) => progressCb && progressCb(msg);

  await ensureCreativoReferenceMedia(c, cfg, log);

  // Step 2: Generar copy adaptado a GO APPLE
  log("Generando copy con IA…");
  c._contentType = c.contentType;
  const copy = await aiGenerateCopyForCreativo(cfg, c);
  c.copy = copy;

  // Step 3: Generar título corto
  log("Generando título…");
  try {
    const title = await aiGenerateTitle(cfg, copy);
    if (title) c.title = title;
  } catch (e) { /* keep original title */ }

  // Step 4: Generar descripción para redes
  log("Generando descripción para redes…");
  try {
    const desc = await aiGenerateDescription(cfg, copy);
    if (desc) c.description = desc;
  } catch (e) { /* not critical */ }

  // Step 5: Generar imágenes (desactivado si diseño manual)
  const contentType = c.contentType || "single";
  const useEngine = isCreativosImageGenEnabled() && window.CreativosEngine && cfg.ideogramKey;
  const hasImageEngine = isCreativosImageGenEnabled() && !useEngine && (cfg.ideogramKey || cfg.openaiKey);
  if (contentType !== "reel" && hasImageEngine) {
    const imgEngine = cfg.ideogramKey ? "ideogram" : "openai";
    const imgApiKey = cfg.ideogramKey || cfg.openaiKey;
    const brandName = cfg.brandName || "GO APPLE";

    const refImages = c.mediaUrls || [];
    const slideCount = contentType === "carousel" ? Math.min(refImages.length || 1, 6) : 1;
    const slideTexts = splitCopyIntoSlides(c.copy || "", slideCount);

    log("Clasificando tipo de post…");
    const firstRef = refImages[0] || null;
    const fullCopy = c.copy || "";
    let postPreset;
    try {
      postPreset = await classifySlidePreset(firstRef, fullCopy, slideCount, cfg.openaiKey);
    } catch (e) {
      postPreset = slideCount > 1 ? "carousel" : "single";
    }
    log(`Tipo detectado: ${IMAGE_PRESETS[postPreset]?.label || postPreset}`);

    log(`Generando ${slideCount} imagen(es) [${postPreset}]…`);
    try {
      const generatedImages = [];
      for (let i = 0; i < slideCount; i++) {
        const slideLabel = slideCount > 1 ? ` (slide ${i + 1}/${slideCount})` : "";
        log(`Extrayendo headline${slideLabel}…`);

        const product = detectProductFromText(slideTexts[i] || fullCopy);
        const productName = PRODUCT_NAME_MAP[product] || "iPhone 15 Pro";
        const headline = await extractHeadline(slideTexts[i] || "", postPreset, i, cfg.openaiKey);
        log(`Generando imagen${slideLabel} → "${headline}"`);

        const imgPrompt = buildImagePromptFromPreset(postPreset, productName, headline, brandName, i, slideCount);
        const imgDataUri = await generateImageWithAI(imgApiKey, imgPrompt, imgEngine, null);
        if (imgDataUri) {
          if (imgDataUri.startsWith("data:")) {
            try { generatedImages.push(await resizeImageDataUri(imgDataUri, 1080)); }
            catch (e) { generatedImages.push(imgDataUri); }
          } else {
            log(`Descargando imagen generada${slideLabel}…`);
            try {
              const dl = await withTimeout(fetchMediaAsDataUri(imgDataUri), 20000);
              generatedImages.push(dl.dataUri ? await resizeImageDataUri(dl.dataUri, 1080) : imgDataUri);
            } catch (e) { generatedImages.push(imgDataUri); }
          }
        }
      }

      if (generatedImages.length > 0) {
        await saveGeneratedImages(c.id, generatedImages);
        c.hasGeneratedImages = true;
        c.generatedImageCount = generatedImages.length;
        c.resultImageUrl = "idb";
        log(`${generatedImages.length} imagen(es) generada(s) ✓`);
      }
    } catch (e) {
      log(`Error generando imágenes: ${e.message}`);
      console.error("[ImageGen] Error:", e);
      c.notes = (c.notes ? c.notes + " | " : "") + `ImageGen: ${e.message}`;
    }
  }

  if (contentType !== "reel" && !c.hasGeneratedImages && isCreativosImageGenEnabled()) {
    log("⚠ No se generaron imágenes. Configurá OpenAI o Ideogram.");
  }
  if (!isCreativosImageGenEnabled() && c.copy) {
    c.status = "copy_listo";
  } else {
    c.status = contentType === "reel" ? "copy_listo" : (c.hasGeneratedImages ? "generado" : "copy_listo");
  }
  c.updatedAt = new Date().toISOString();

  delete c._contentType;
  delete c._transcript;
  delete c._slideDescriptions;

  return c;
}

function splitCopyIntoSlides(copy, totalSlides) {
  if (!copy) return [copy || ""];

  const slideRegex = /(?:slide|Slide|SLIDE)\s*\d+\s*[:.\-]\s*/gi;
  const parts = copy.split(slideRegex).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;

  if (totalSlides <= 1) return [copy];

  const lines = copy.split(/\n+/).filter((l) => l.trim());
  if (lines.length >= totalSlides) {
    const perSlide = Math.ceil(lines.length / totalSlides);
    const chunks = [];
    for (let i = 0; i < totalSlides; i++) {
      chunks.push(lines.slice(i * perSlide, (i + 1) * perSlide).join("\n"));
    }
    return chunks;
  }

  const sentences = copy.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  if (sentences.length >= totalSlides) {
    const perSlide = Math.ceil(sentences.length / totalSlides);
    const chunks = [];
    for (let i = 0; i < totalSlides; i++) {
      chunks.push(sentences.slice(i * perSlide, (i + 1) * perSlide).join(" "));
    }
    return chunks;
  }

  return [copy];
}

const PRODUCT_NAME_MAP = {
  iphone: "iPhone 15 Pro",
  airpods: "AirPods Pro",
  watch: "Apple Watch Series 9",
  mac: "MacBook Pro",
  ipad: "iPad Pro",
};

function buildImagePromptFromPreset(presetKey, productName, headline, brandName, slideIdx, totalSlides) {
  const preset = IMAGE_PRESETS[presetKey] || IMAGE_PRESETS["carousel"];
  const prompt = preset.promptPerSlide(productName, headline, brandName, slideIdx, totalSlides);
  console.log(`[Preset] ${presetKey} slide ${slideIdx + 1}/${totalSlides} → ${prompt.slice(0, 120)}…`);
  return prompt;
}

/* ═══════════════════════════════════════════════════════════
   Apple Template Engine — render slides via html2canvas
   ═══════════════════════════════════════════════════════════ */
const PRODUCT_IMAGES = {
  iphone:   "./assets/products/iphone.png",
  airpods:  "./assets/products/airpods.png",
  watch:    "./assets/products/watch.png",
  mac:      "./assets/products/mac.png",
  ipad:     "./assets/products/ipad.png",
  default:  "./assets/products/iphone.png",
};

function detectProductFromText(text) {
  const t = (text || "").toLowerCase();
  if (/ipad|tablet/i.test(t)) return "ipad";
  if (/mac|macbook|imac|laptop|computadora/i.test(t)) return "mac";
  if (/airpod|auricular|buds/i.test(t)) return "airpods";
  if (/watch|reloj|apple\s*watch/i.test(t)) return "watch";
  return "iphone";
}

function stripEmojis(str) {
  return str.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "").replace(/\s{2,}/g, " ").trim();
}

function splitHeadlineAndSub(text) {
  const clean = stripEmojis(text.replace(/^["'""'']+|["'""'']+$/g, "")).trim();
  const lines = clean.split(/\n+/).filter(Boolean);

  if (lines.length >= 2) {
    return { headline: lines[0], sub: lines.slice(1).join(" ") };
  }

  const sentences = clean.split(/(?<=[.!?])\s+/);
  if (sentences.length >= 2 && sentences[0].length <= 80) {
    return { headline: sentences[0], sub: sentences.slice(1).join(" ") };
  }

  if (clean.length > 80) {
    const mid = clean.lastIndexOf(" ", 70);
    if (mid > 20) {
      return { headline: clean.slice(0, mid), sub: clean.slice(mid + 1) };
    }
  }

  return { headline: clean, sub: "" };
}

async function renderSlideFromTemplate(brand, slideText, slideType, slideIndex, totalSlides) {
  const root = document.getElementById("apple-tpl-root");
  if (!root) throw new Error("Template container not found");

  const { headline, sub } = splitHeadlineAndSub(slideText);
  const productKey = detectProductFromText(slideText);
  const productSrc = PRODUCT_IMAGES[productKey] || PRODUCT_IMAGES.default;

  const useDark = slideType === "content" && slideIndex % 2 === 1;

  root.className = "apple-tpl" +
    (useDark ? " apple-tpl--dark" : "") +
    (headline.length > 60 ? " apple-tpl--small-text" : "");

  root.querySelector(".apple-tpl__brand").textContent = brand.name || "GO APPLE";
  root.querySelector(".apple-tpl__headline").textContent = headline;

  const subEl = root.querySelector(".apple-tpl__sub");
  subEl.textContent = sub;
  subEl.style.display = sub ? "" : "none";

  const imgEl = root.querySelector(".apple-tpl__product-img");
  await new Promise((resolve) => {
    imgEl.onload = resolve;
    imgEl.onerror = resolve;
    imgEl.src = productSrc;
  });

  const ctaZone = root.querySelector(".apple-tpl__cta-zone");
  if (slideType === "cta") {
    ctaZone.hidden = false;
    ctaZone.querySelector(".apple-tpl__cta-btn").textContent = "Contactanos";
  } else {
    ctaZone.hidden = true;
  }

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const canvas = await html2canvas(root, {
    width: 1080,
    height: 1080,
    scale: 1,
    useCORS: true,
    backgroundColor: null,
    logging: false,
  });

  return canvas.toDataURL("image/png");
}

async function generateImageWithAI(apiKey, prompt, engine, referenceDataUri) {
  if (engine === "ideogram") return generateImageWithIdeogram(apiKey, prompt);
  return generateImageWithOpenAI(apiKey, prompt, referenceDataUri);
}

async function generateImageWithIdeogram(ideogramKey, prompt) {
  console.log("[Ideogram] Prompt enviado:", prompt);
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("rendering_speed", "QUALITY");
  form.append("aspect_ratio", "1x1");
  form.append("magic_prompt", "AUTO");

  const apiResp = await fetch("/api/ideogram/v1/ideogram-v3/generate", {
    method: "POST",
    headers: { "Api-Key": ideogramKey },
    body: form,
  });
  if (!apiResp.ok) {
    const err = await apiResp.json().catch(() => ({}));
    throw new Error(err.message || err.detail || err.error || `Ideogram ${apiResp.status}`);
  }
  const data = await apiResp.json();
  const url = data.data?.[0]?.url;
  if (!url) return null;

  try {
    const dlResp = await withTimeout(fetch("/api/fetch-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }), 30000);
    const dl = await dlResp.json();
    return dl.dataUri || url;
  } catch (e) {
    console.warn("[Ideogram] Could not download image, returning URL:", e.message);
    return url;
  }
}

async function generateImageWithOpenAI(openaiKey, prompt, referenceDataUri) {
  const body = {
    model: "gpt-image-1",
    prompt: prompt,
    n: 1,
    size: "1024x1024",
    quality: "high",
  };

  if (referenceDataUri && referenceDataUri.startsWith("data:")) {
    const b64Part = referenceDataUri.split(",")[1];
    if (b64Part) {
      body.image = [{ type: "base64", media_type: "image/png", data: b64Part }];
    }
  }

  const resp = await fetch("/api/openai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Image gen ${resp.status}`);
  }
  const data = await resp.json();

  const b64 = data.data?.[0]?.b64_json;
  if (b64) return `data:image/png;base64,${b64}`;

  const url = data.data?.[0]?.url;
  if (!url) return null;
  try {
    const imgResp = await withTimeout(fetch(url), 30000);
    const blob = await imgResp.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn("[ImageGen] Could not download image, returning URL:", e.message);
    return url;
  }
}

/* ── Re-generar SOLO copy/título/descripción ── */
async function regenCopyOnly(creativoId) {
  const cfg = getCreativosConfig();
  if (!cfg.openaiKey) { alert("Configurá la API Key de OpenAI en Configuraciones → Creativos / IA."); return; }
  const list = getCreativos();
  const c = list.find((x) => x.id === creativoId);
  if (!c) return;

  const bar = document.getElementById("creativos-progress");
  const log = (msg) => { if (bar) { bar.hidden = false; bar.textContent = msg; } };

  try {
    log("Generando copy con IA…");
    c._contentType = c.contentType;
    c._transcript = c.transcript;
    const copy = await aiGenerateCopyForCreativo(cfg, c);
    c.copy = copy;

    log("Generando título…");
    try { const t = await aiGenerateTitle(cfg, copy); if (t) c.title = t; } catch (e) {}

    log("Generando descripción…");
    try { const d = await aiGenerateDescription(cfg, copy); if (d) c.description = d; } catch (e) {}

    delete c._contentType;
    delete c._transcript;
    c.updatedAt = new Date().toISOString();
    if (!c.hasGeneratedImages) c.status = "copy_listo";

    saveCreativos(list);
    renderCreativos();
    renderSectionKpis();
    log(`Copy re-generado ✓`);
    setTimeout(() => { if (bar) bar.hidden = true; }, 3000);
  } catch (err) {
    log(`❌ Error: ${err.message}`);
    setTimeout(() => { if (bar) bar.hidden = true; }, 5000);
  }
}

/* ── Re-generar SOLO imágenes (usa referencia + IA) ── */
async function regenImagesOnly(creativoId) {
  if (!isCreativosImageGenEnabled()) {
    alert("La generación de imágenes con IA está desactivada. Diseñá manualmente y subí las imágenes al creativo.");
    return;
  }
  const cfg = getCreativosConfig();
  if (!cfg.ideogramKey) { alert("Configurá la API Key de Ideogram en Configuraciones → Creativos / IA."); return; }
  const list = getCreativos();
  const c = list.find((x) => x.id === creativoId);
  if (!c) return;
  if ((c.contentType || "single") === "reel") { alert("Los reels solo generan copy, no imágenes."); return; }

  const bar = document.getElementById("creativos-progress");
  try {
    await window.CreativosEngine.regenImages(c, cfg, (msg) => {
      if (bar) { bar.hidden = false; bar.textContent = msg; }
    });
    saveCreativos(list);
    renderCreativos();
    renderSectionKpis();
    if (bar) { bar.textContent = `${c.generatedImageCount || 0} imagen(es) re-generada(s)`; setTimeout(() => { bar.hidden = true; }, 3000); }
  } catch (e) {
    if (bar) { bar.textContent = `Error: ${e.message}`; setTimeout(() => { bar.hidden = true; }, 5000); }
  }
}

/* ── Procesar UN solo creativo (pipeline completo, primera vez) ── */
async function processSingleCreativo(creativoId) {
  const cfg = getCreativosConfig();
  if (!cfg.openaiKey) {
    alert("Configurá la API Key de OpenAI en Configuraciones → Creativos / IA.");
    return;
  }
  const list = getCreativos();
  const c = list.find((x) => x.id === creativoId);
  if (!c) return;

  const bar = document.getElementById("creativos-progress");
  const log = (msg) => { if (bar) { bar.hidden = false; bar.textContent = msg; } };
  try {
    await fullPipelineCreativo(c, cfg, log);

    if (isCreativosImageGenEnabled() && window.CreativosEngine && cfg.ideogramKey && c.contentType !== "reel") {
      await window.CreativosEngine.processCreativo(c, cfg, log);
    }

    saveCreativos(list);
    renderCreativos();
    renderSectionKpis();
    const summary = c.hasGeneratedImages
      ? `"${c.title}" procesado — ${c.generatedImageCount} imagen(es) IA`
      : `"${c.title}" procesado — solo copy`;
    if (bar) { bar.textContent = summary; setTimeout(() => { bar.hidden = true; }, 5000); }
    switchCreativosSubtab("workspace");
  } catch (err) {
    c.notes = (c.notes ? c.notes + " | " : "") + `Error: ${err.message}`;
    saveCreativos(list);
    if (bar) { bar.textContent = `Error: ${err.message}`; setTimeout(() => { bar.hidden = true; }, 5000); }
  }
}

/* ── Lightbox dinámico: se crea al abrir, se destruye al cerrar ── */
function openLightbox(creativoId) {
  const c = getCreativos().find((x) => x.id === creativoId);
  if (!c) return;
  const media = c.mediaUrls || [];
  const isReel = c.contentType === "reel";
  const hasVideo = isReel && c.videoUrl;
  if (media.length === 0 && !hasVideo) { if (c.postUrl) window.open(c.postUrl, "_blank"); return; }

  document.getElementById("ga-lightbox")?.remove();

  const isCarousel = media.length > 1 && !isReel;

  /* ── Media section (left side) ── */
  let mediaHtml;
  if (hasVideo) {
    const videoSrc = c.videoUrl.startsWith("data:") ? c.videoUrl : `/api/fetch-video?url=${encodeURIComponent(c.videoUrl)}`;
    const thumbForVideo = media.length > 0 ? `poster="${media[0]}"` : "";
    mediaHtml = `
      <div class="ga-lb__viewer">
        <video class="ga-lb__video" controls playsinline preload="metadata" ${thumbForVideo} id="ga-lb-video">
          <source src="${escapeHtml(videoSrc)}" type="video/mp4" />
        </video>
        <div class="ga-lb__video-fallback" id="ga-lb-video-fallback" style="display:none">
          <p>No se pudo cargar el video</p>
          ${c.postUrl ? `<a href="${escapeHtml(c.postUrl)}" target="_blank" rel="noopener" class="ga-lb__link">Ver en Instagram ↗</a>` : ""}
        </div>
      </div>`;
  } else if (isCarousel) {
    const dots = media.map((_, i) => `<span class="ga-lb__dot${i === 0 ? " active" : ""}" data-i="${i}"></span>`).join("");
    mediaHtml = `
      <div class="ga-lb__viewer">
        <img src="${media[0]}" class="ga-lb__img" id="ga-lb-img" data-index="0" />
        <button class="ga-lb__arrow ga-lb__arrow--prev" id="ga-lb-prev">‹</button>
        <button class="ga-lb__arrow ga-lb__arrow--next" id="ga-lb-next">›</button>
        <div class="ga-lb__dots">${dots}</div>
      </div>`;
  } else {
    mediaHtml = `
      <div class="ga-lb__viewer">
        <img src="${media[0] || c.refUrl}" class="ga-lb__img" />
      </div>`;
  }

  /* ── Info section (right side) ── */
  const igHandle = (c.postUrl || "").match(/instagram\.com\/([^\/]+)/)?.[1] || "";
  const accountName = c.source || igHandle || "Referencia";

  const typeBadge = isCarousel
    ? `<span class="ga-lb__badge ga-lb__badge--carousel">🖼 Carrusel · ${media.length} slides</span>`
    : isReel
      ? `<span class="ga-lb__badge ga-lb__badge--reel">🎬 Reel</span>`
      : `<span class="ga-lb__badge ga-lb__badge--single">📷 Imagen</span>`;

  const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" }) : "";

  const copyText = formatCopyAsSlides(c.copy || "");
  const descText = c.description || "";
  const transcriptText = c.transcript || "";

  const titleSnippet = (c.title || "").length > 200 ? c.title.slice(0, 197) + "…" : (c.title || "");

  const infoHtml = `
    <div class="ga-lb__info">
      <div class="ga-lb__info-header">
        <div class="ga-lb__info-account">
          <div class="ga-lb__info-avatar-circle">${escapeHtml(accountName.charAt(0).toUpperCase())}</div>
          <div class="ga-lb__info-account-text">
            <strong class="ga-lb__info-handle">${escapeHtml(accountName)}</strong>
            ${igHandle ? `<span class="ga-lb__info-ig">@${escapeHtml(igHandle)}</span>` : ""}
          </div>
        </div>
        <button class="ga-lb__close" aria-label="Cerrar">✕</button>
      </div>

      <div class="ga-lb__info-scroll">
        <div class="ga-lb__info-row">
          ${typeBadge}
          ${dateStr ? `<span class="ga-lb__date">${dateStr}</span>` : ""}
        </div>

        ${titleSnippet ? `<div class="ga-lb__section"><label class="ga-lb__label">Descripción del post</label><p class="ga-lb__text">${escapeHtml(titleSnippet)}</p></div>` : ""}

        ${copyText ? `<div class="ga-lb__section"><label class="ga-lb__label">COPY</label><div class="ga-lb__text">${copyText}</div></div>` : ""}

        ${descText ? `<div class="ga-lb__section"><label class="ga-lb__label">Descripción generada</label><p class="ga-lb__text ga-lb__text--muted">${escapeHtml(descText)}</p></div>` : ""}

        ${transcriptText ? `<div class="ga-lb__section"><label class="ga-lb__label">Texto extraído (OCR/Whisper)</label><p class="ga-lb__text ga-lb__text--muted">${escapeHtml(transcriptText)}</p></div>` : ""}

        ${!copyText && !descText && !transcriptText ? `<div class="ga-lb__empty-hint"><span>✨</span><p>Procesá esta referencia para generar copy y descripción automáticamente.</p></div>` : ""}
      </div>

      <div class="ga-lb__info-footer">
        ${c.postUrl ? `<a href="${escapeHtml(c.postUrl)}" target="_blank" rel="noopener" class="ga-lb__link">Ver post original ↗</a>` : ""}
        <div class="ga-lb__footer-actions">
          ${copyText ? `<button type="button" class="ga-lb__copy-btn" id="ga-lb-copy">📋 Copiar copy</button>` : ""}
          <button type="button" class="ga-lb__process-btn" id="ga-lb-process" data-id="${escapeHtml(c.id)}">⚡ Procesar</button>
        </div>
      </div>
    </div>`;

  const overlay = document.createElement("div");
  overlay.id = "ga-lightbox";
  overlay.className = "ga-lb";
  overlay.innerHTML = `
    <div class="ga-lb__backdrop"></div>
    <div class="ga-lb__panel card glass-panel">
      ${mediaHtml}
      ${infoHtml}
    </div>`;

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const close = () => { overlay.remove(); document.body.style.overflow = ""; };
  overlay.querySelector(".ga-lb__backdrop").addEventListener("click", close);
  overlay.querySelector(".ga-lb__close").addEventListener("click", close);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });

  const videoEl = overlay.querySelector("#ga-lb-video");
  if (videoEl) {
    const fallback = overlay.querySelector("#ga-lb-video-fallback");
    videoEl.addEventListener("error", () => {
      videoEl.style.display = "none";
      if (fallback) fallback.style.display = "flex";
    });
    videoEl.addEventListener("stalled", () => {
      setTimeout(() => {
        if (videoEl.readyState < 2 && fallback) {
          videoEl.style.display = "none";
          fallback.style.display = "flex";
        }
      }, 8000);
    });
  }

  overlay.querySelector("#ga-lb-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(c.copy || "").then(() => {
      const btn = overlay.querySelector("#ga-lb-copy");
      if (btn) { btn.textContent = "✓ Copiado"; setTimeout(() => btn.textContent = "📋 Copiar copy", 1500); }
    });
  });

  overlay.querySelector("#ga-lb-process")?.addEventListener("click", () => {
    close();
    processSingleCreativo(creativoId);
  });

  if (isCarousel) {
    const navigate = (dir) => {
      const img = document.getElementById("ga-lb-img");
      if (!img) return;
      let idx = Number(img.dataset.index || 0) + dir;
      if (idx < 0) idx = media.length - 1;
      if (idx >= media.length) idx = 0;
      img.style.opacity = "0";
      setTimeout(() => { img.src = media[idx]; img.dataset.index = idx; img.style.opacity = "1"; }, 150);
      overlay.querySelectorAll(".ga-lb__dot").forEach((d, i) => d.classList.toggle("active", i === idx));
    };
    overlay.querySelector("#ga-lb-prev")?.addEventListener("click", () => navigate(-1));
    overlay.querySelector("#ga-lb-next")?.addEventListener("click", () => navigate(1));
    overlay.querySelectorAll(".ga-lb__dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        const idx = Number(dot.dataset.i);
        const img = document.getElementById("ga-lb-img");
        if (!img) return;
        img.style.opacity = "0";
        setTimeout(() => { img.src = media[idx]; img.dataset.index = idx; img.style.opacity = "1"; }, 150);
        overlay.querySelectorAll(".ga-lb__dot").forEach((d, i) => d.classList.toggle("active", i === idx));
      });
    });
  }
}
function closeRefPreview() { const el = document.getElementById("ga-lightbox"); if (el) { el.remove(); document.body.style.overflow = ""; } }

async function openLightboxGen(creativoId) {
  const c = getCreativos().find((x) => x.id === creativoId);
  if (!c) return;

  let genImgs = [];
  if (c.hasGeneratedImages) {
    try {
      genImgs = await loadGeneratedImages(creativoId);
      console.log(`[LB-Gen] Loaded ${genImgs.length} generated images from IndexedDB for ${creativoId}`);
    } catch (e) {
      console.error("[LB-Gen] Error loading from IndexedDB:", e);
    }
  } else {
    console.log(`[LB-Gen] No hasGeneratedImages flag for ${creativoId}. Status: ${c.status}, notes: ${c.notes || "none"}`);
  }
  const refMedia = c.mediaUrls || [];
  const hasGenImages = genImgs.length > 0;
  const media = hasGenImages ? genImgs : refMedia;
  if (media.length === 0 && !c.copy) return;

  document.getElementById("ga-lightbox")?.remove();

  const isCarousel = media.length > 1;

  let mediaHtml;
  if (media.length > 0) {
    const tabRef = refMedia.length > 0
      ? `<button class="ga-lb__media-tab ${!hasGenImages ? "active" : ""}" data-src="ref">Referencia</button>` : "";
    const tabGen = hasGenImages
      ? `<button class="ga-lb__media-tab ${hasGenImages ? "active" : ""}" data-src="gen">IA Generado</button>` : "";
    const mediaTabs = (tabRef && tabGen) ? `<div class="ga-lb__media-tabs">${tabRef}${tabGen}</div>` : "";

    if (isCarousel) {
      const dots = media.map((_, i) => `<span class="ga-lb__dot${i === 0 ? " active" : ""}" data-i="${i}"></span>`).join("");
      mediaHtml = `
        <div class="ga-lb__viewer">
          ${mediaTabs}
          <img src="${media[0]}" class="ga-lb__img" id="ga-lb-img" data-index="0" />
          <button class="ga-lb__arrow ga-lb__arrow--prev" id="ga-lb-prev">‹</button>
          <button class="ga-lb__arrow ga-lb__arrow--next" id="ga-lb-next">›</button>
          <div class="ga-lb__dots">${dots}</div>
          <span class="ga-lb__slide-counter" id="ga-lb-counter">1 / ${media.length}</span>
        </div>`;
    } else {
      mediaHtml = `<div class="ga-lb__viewer">${mediaTabs}<img src="${media[0]}" class="ga-lb__img" /></div>`;
    }
  } else {
    mediaHtml = `<div class="ga-lb__viewer ga-lb__viewer--empty"><div class="ga-lb__empty-media"><span style="font-size:40px">🎬</span><p>Solo copy generado (reel/video)</p></div></div>`;
  }

  const igHandle = (c.postUrl || "").match(/instagram\.com\/([^\/]+)/)?.[1] || "";
  const accountName = c.source || igHandle || "GO APPLE";
  const statusLabel = CREATIVO_STATUSES[c.status] || c.status;
  const statusColor = CREATIVO_STATUS_COLORS[c.status] || "#94a3b8";

  const contentType = c.contentType || "single";
  const typeIcon = contentType === "carousel" ? "🖼" : contentType === "reel" ? "🎬" : "📷";
  const typeLabel = contentType === "carousel" ? "Carrusel" : contentType === "reel" ? "Reel" : "Imagen";

  const infoHtml = `
    <div class="ga-lb__info">
      <div class="ga-lb__info-header">
        <div class="ga-lb__info-account">
          <div class="ga-lb__info-avatar-circle">${escapeHtml(accountName.charAt(0).toUpperCase())}</div>
          <div class="ga-lb__info-account-text">
            <strong class="ga-lb__info-handle">${escapeHtml(c.title || accountName)}</strong>
            <span class="ga-lb__info-ig">@${escapeHtml(accountName)}</span>
          </div>
        </div>
        <button class="ga-lb__close" aria-label="Cerrar">✕</button>
      </div>

      <div class="ga-lb__info-meta">
        <span class="ga-lb__meta-pill">${typeIcon} ${typeLabel}</span>
        <span class="ga-lb__meta-pill" style="background:${statusColor}20;color:${statusColor};border-color:${statusColor}40">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor}"></span> ${escapeHtml(statusLabel)}
        </span>
        ${hasGenImages ? `<span class="ga-lb__meta-pill ga-lb__meta-pill--ai">✨ ${genImgs.length} slides IA</span>` : ""}
      </div>

      <div class="ga-lb__info-scroll">
        ${c.copy ? `<div class="ga-lb__section"><label class="ga-lb__label">COPY</label><div class="ga-lb__text" id="ga-lb-copy-editable">${formatCopyAsSlides(c.copy, true)}</div></div>` : ""}
        ${c.description ? `<div class="ga-lb__section"><label class="ga-lb__label">Descripción</label><p class="ga-lb__text ga-lb__text--muted">${escapeHtml(c.description)}</p></div>` : ""}
        ${c.transcript ? `<div class="ga-lb__section"><label class="ga-lb__label">Texto extraído</label><p class="ga-lb__text ga-lb__text--muted">${escapeHtml(c.transcript)}</p></div>` : ""}
      </div>

      <div class="ga-lb__info-footer ga-lb__info-footer--gen">
        <div class="ga-lb__footer-actions ga-lb__footer-actions--full">
          ${c.copy ? `<button type="button" class="ga-lb__action-btn" id="ga-lb-copy"><span>📋</span> Copiar copy</button>` : ""}
          ${c.description ? `<button type="button" class="ga-lb__action-btn" id="ga-lb-copy-desc"><span>📝</span> Copiar desc</button>` : ""}
        </div>
        <div class="ga-lb__footer-main">
          <button type="button" class="ga-lb__regen-copy-btn" id="ga-lb-regen-copy">🔄 Re-generar copy</button>
          ${contentType !== "reel" && isCreativosImageGenEnabled() ? `<button type="button" class="ga-lb__regen-img-btn" id="ga-lb-regen-img">🎨 Re-generar imágenes</button>` : ""}
        </div>
        <div class="ga-lb__footer-main">
          ${hasGenImages ? `<button type="button" class="ga-lb__download-btn" id="ga-lb-download-all">⬇ Descargar todo</button>` : ""}
          ${c.postUrl ? `<a href="${escapeHtml(c.postUrl)}" target="_blank" rel="noopener" class="ga-lb__link-btn">↗ Post original</a>` : ""}
        </div>
      </div>
    </div>`;

  const overlay = document.createElement("div");
  overlay.id = "ga-lightbox";
  overlay.className = "ga-lb";
  overlay.innerHTML = `
    <div class="ga-lb__backdrop"></div>
    <div class="ga-lb__panel card glass-panel">
      ${mediaHtml}
      ${infoHtml}
    </div>`;

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const close = () => { overlay.remove(); document.body.style.overflow = ""; };
  overlay.querySelector(".ga-lb__backdrop").addEventListener("click", close);
  overlay.querySelector(".ga-lb__close").addEventListener("click", close);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });

  overlay.querySelector("#ga-lb-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(c.copy || "").then(() => {
      const btn = overlay.querySelector("#ga-lb-copy");
      if (btn) { btn.textContent = "✓ Copiado"; setTimeout(() => btn.textContent = "📋 Copiar copy", 1500); }
    });
  });
  overlay.querySelector("#ga-lb-copy-desc")?.addEventListener("click", () => {
    navigator.clipboard.writeText(c.description || "").then(() => {
      const btn = overlay.querySelector("#ga-lb-copy-desc");
      if (btn) { btn.textContent = "✓ Copiado"; setTimeout(() => btn.textContent = "📝 Copiar desc", 1500); }
    });
  });

  overlay.querySelector("#ga-lb-regen-copy")?.addEventListener("click", async () => {
    const btn = overlay.querySelector("#ga-lb-regen-copy");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Generando copy…"; }
    close();
    await regenCopyOnly(creativoId);
  });
  overlay.querySelector("#ga-lb-regen-img")?.addEventListener("click", async () => {
    const btn = overlay.querySelector("#ga-lb-regen-img");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Generando imágenes…"; }
    close();
    await regenImagesOnly(creativoId);
  });

  function collectEditedCopy() {
    const container = overlay.querySelector("#ga-lb-copy-editable");
    if (!container) return null;
    const areas = container.querySelectorAll(".ga-lb__slide-edit");
    if (areas.length === 0) return null;
    const parts = [];
    areas.forEach(ta => {
      const slideIdx = ta.dataset.slide;
      const val = ta.value.trim();
      if (!val) return;
      if (slideIdx === "general") {
        parts.push(val);
      } else {
        parts.push("Slide " + slideIdx + ":\n" + val);
      }
    });
    return parts.join("\n\n");
  }

  overlay.querySelector("#ga-lb-save-copy")?.addEventListener("click", () => {
    const newCopy = collectEditedCopy();
    if (newCopy == null) return;
    c.copy = newCopy;
    c.updatedAt = new Date().toISOString();
    persistCreativos();
    renderCreativos();
    const btn = overlay.querySelector("#ga-lb-save-copy");
    if (btn) { btn.textContent = "✓ Guardado"; setTimeout(() => btn.textContent = "💾 Guardar copy", 1500); }
  });

  overlay.querySelector("#ga-lb-save-regen")?.addEventListener("click", async () => {
    const newCopy = collectEditedCopy();
    if (newCopy == null) return;
    c.copy = newCopy;
    c.updatedAt = new Date().toISOString();
    persistCreativos();
    renderCreativos();
    const btn = overlay.querySelector("#ga-lb-save-regen");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Guardado, generando…"; }
    close();
    await regenImagesOnly(creativoId);
  });

  overlay.querySelector("#ga-lb-download-all")?.addEventListener("click", () => {
    genImgs.forEach((src, i) => {
      const a = document.createElement("a");
      a.href = src;
      a.download = `${(c.title || "slide").replace(/[^a-zA-Z0-9]/g, "_")}_${i + 1}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });

  // Media tabs: switch between reference and generated
  overlay.querySelectorAll(".ga-lb__media-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const src = tab.dataset.src;
      const imgs = src === "gen" ? genImgs : refMedia;
      if (imgs.length === 0) return;
      overlay.querySelectorAll(".ga-lb__media-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const imgEl = overlay.querySelector(".ga-lb__img");
      if (imgEl) { imgEl.src = imgs[0]; imgEl.dataset.index = "0"; }
      const counter = overlay.querySelector("#ga-lb-counter");
      if (counter) counter.textContent = `1 / ${imgs.length}`;
      overlay.querySelectorAll(".ga-lb__dot").forEach((d, i) => {
        d.classList.toggle("active", i === 0);
        d.style.display = i < imgs.length ? "" : "none";
      });
      overlay._currentMedia = imgs;
    });
  });
  overlay._currentMedia = media;

  if (isCarousel) {
    const navigate = (dir) => {
      const currentMedia = overlay._currentMedia || media;
      const img = document.getElementById("ga-lb-img");
      if (!img) return;
      let idx = Number(img.dataset.index || 0) + dir;
      if (idx < 0) idx = currentMedia.length - 1;
      if (idx >= currentMedia.length) idx = 0;
      img.style.opacity = "0";
      setTimeout(() => { img.src = currentMedia[idx]; img.dataset.index = idx; img.style.opacity = "1"; }, 150);
      overlay.querySelectorAll(".ga-lb__dot").forEach((d, i) => d.classList.toggle("active", i === idx));
      const counter = overlay.querySelector("#ga-lb-counter");
      if (counter) counter.textContent = `${idx + 1} / ${currentMedia.length}`;
    };
    overlay.querySelector("#ga-lb-prev")?.addEventListener("click", () => navigate(-1));
    overlay.querySelector("#ga-lb-next")?.addEventListener("click", () => navigate(1));
    overlay.querySelectorAll(".ga-lb__dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        const currentMedia = overlay._currentMedia || media;
        const idx = Number(dot.dataset.i);
        const img = document.getElementById("ga-lb-img");
        if (!img || idx >= currentMedia.length) return;
        img.style.opacity = "0";
        setTimeout(() => { img.src = currentMedia[idx]; img.dataset.index = idx; img.style.opacity = "1"; }, 150);
        overlay.querySelectorAll(".ga-lb__dot").forEach((d, i) => d.classList.toggle("active", i === idx));
        const counter = overlay.querySelector("#ga-lb-counter");
        if (counter) counter.textContent = `${idx + 1} / ${currentMedia.length}`;
      });
    });
  }
}

function switchCreativosSubtab(name) {
  document.querySelectorAll(".creativos-subtab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subtab === name);
  });
  const compPanel = document.getElementById("creativos-panel-competidores");
  const workPanel = document.getElementById("creativos-panel-workspace");
  if (compPanel) compPanel.hidden = name !== "competidores";
  if (workPanel) workPanel.hidden = name !== "workspace";
  if (name === "workspace") updateCreativosOpenAIStatus();
}

function initCreativosKanbanDragDrop() {
  const workspace = document.getElementById("creativos-workspace");
  if (!workspace || workspace.dataset.kanbanInit === "1") return;
  workspace.dataset.kanbanInit = "1";

  let draggedId = null;

  workspace.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".kanban-card");
    if (!card) return;
    draggedId = card.dataset.id;
    card.classList.add("kanban-card--dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedId);
  });

  workspace.addEventListener("dragend", (e) => {
    e.target.closest(".kanban-card")?.classList.remove("kanban-card--dragging");
    workspace.querySelectorAll(".creativos-kanban__col--over").forEach((el) => el.classList.remove("creativos-kanban__col--over"));
    draggedId = null;
  });

  workspace.querySelectorAll(".creativos-kanban__col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("creativos-kanban__col--over");
    });
    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("creativos-kanban__col--over");
    });
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("creativos-kanban__col--over");
      const id = draggedId || e.dataTransfer.getData("text/plain");
      const toStage = col.dataset.stage;
      const card = workspace.querySelector(`.kanban-card[data-id="${id}"]`);
      const fromStage = card?.dataset.stage;
      if (id && toStage) await moveCreativoToStage(id, toStage, fromStage);
    });
  });
}

/* ── Generar copy desde el modal ── */
async function generateCreativoCopy() {
  const cfg = getCreativosConfig();
  if (!cfg.openaiKey) {
    alert("Configurá la API Key de OpenAI en Configuraciones → Creativos / IA.");
    return;
  }
  const title = (document.getElementById("creativo-title")?.value || "").trim();
  if (!title) { alert("Completá al menos el título."); return; }

  const statusEl = document.getElementById("creativo-ai-status");
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = "Generando copy con IA…"; }

  try {
    const mockCreativo = {
      title,
      source: (document.getElementById("creativo-source")?.value || "").trim(),
      refUrl: (document.getElementById("creativo-ref-url")?.value || "").trim(),
      postUrl: "",
    };
    const copy = await aiGenerateCopyForCreativo(cfg, mockCreativo);
    const copyEl = document.getElementById("creativo-copy");
    if (copyEl && copy) copyEl.value = copy;
    if (statusEl) statusEl.textContent = "Copy generado.";
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  }
}

/* ── Generar imagen desde el modal ── */
async function generateCreativoImage() {
  const cfg = getCreativosConfig();
  if (!cfg.openaiKey) {
    alert("Configurá la API Key de OpenAI en Configuraciones → Creativos / IA.");
    return;
  }
  const title = (document.getElementById("creativo-title")?.value || "").trim();
  if (!title) { alert("Completá al menos el título."); return; }

  const statusEl = document.getElementById("creativo-ai-status");
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = "Generando imagen con DALL-E… (puede tardar 15-30 seg)"; }

  try {
    const mockCreativo = {
      title,
      imgPrompt: (document.getElementById("creativo-img-prompt")?.value || "").trim(),
    };
    const imageUrl = await aiGenerateImageForCreativo(cfg, mockCreativo);
    if (imageUrl) {
      const preview = document.getElementById("creativo-result-preview");
      const img = document.getElementById("creativo-result-img");
      if (preview && img) { img.src = imageUrl; preview.hidden = false; }
      if (editingCreativoId) {
        const list = getCreativos();
        const c = list.find((x) => x.id === editingCreativoId);
        if (c) { c.resultImageUrl = imageUrl; c.updatedAt = new Date().toISOString(); saveCreativos(list); }
      }
    }
    if (statusEl) statusEl.textContent = imageUrl ? "Imagen generada. Descargala antes de que expire (1 hora)." : "No se pudo generar la imagen.";
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  }
}

/* ── PROCESAR TODO: flujo automático para referencias pendientes ── */
async function processAllPendingCreativos() {
  const cfg = getCreativosConfig();
  if (!cfg.openaiKey) {
    alert("Configurá la API Key de OpenAI en Configuraciones → Creativos / IA.");
    return;
  }

  const list = getCreativos();
  const pending = list.filter((c) => c.status === "referencia" || c.status === "pendiente");
  if (pending.length === 0) {
    alert("No hay creativos pendientes de procesar.");
    return;
  }

  const hasRapidApi = Boolean(cfg.rapidapiKey);
  const hasPosts = pending.some((c) => c.postUrl);
  let downloadIG = false;
  let genImages = false;

  if (hasRapidApi && hasPosts) {
    downloadIG = confirm(
      `Hay ${pending.length} creativo(s) pendiente(s).\n\n` +
      `Se detectó la RapidAPI Key configurada.\n` +
      `¿Descargar contenido de Instagram automáticamente?\n` +
      `(descarga reels/carruseles, analiza con Vision/Whisper, genera copy)\n\n` +
      `• Aceptar = pipeline completo (como N8N)\n` +
      `• Cancelar = solo generar copy con lo que ya hay`
    );
  }

  genImages = confirm(
    `¿Generar IMÁGENES con DALL-E? (cuesta ~$0.04 USD por imagen)\n\n` +
    `• Aceptar = copy + imagen para cada uno\n` +
    `• Cancelar = solo copy (sin imagen)`
  );

  const bar = document.getElementById("creativos-progress");

  for (let i = 0; i < pending.length; i++) {
    const c = pending[i];
    const label = `${i + 1}/${pending.length}: ${c.title.slice(0, 30)}`;

    try {
      if (downloadIG && c.postUrl) {
        await fullPipelineCreativo(c, cfg, (msg) => {
          if (bar) { bar.hidden = false; bar.textContent = `[${label}] ${msg}`; }
        });
      } else {
        if (bar) { bar.hidden = false; bar.textContent = `Generando copy ${label}…`; }
        c.copy = await aiGenerateCopyForCreativo(cfg, c);
        c.status = "copy_listo";
        c.updatedAt = new Date().toISOString();
      }
    } catch (err) {
      c.notes = (c.notes ? c.notes + " | " : "") + `Error: ${err.message}`;
    }

    if (genImages && c.copy) {
      if (bar) bar.textContent = `Generando imagen ${label}… (DALL-E, puede tardar)`;
      try {
        const imgUrl = await aiGenerateImageForCreativo(cfg, c);
        if (imgUrl) {
          c.resultImageUrl = imgUrl;
          c.status = "listo";
        }
      } catch (err) {
        c.notes = (c.notes ? c.notes + " | " : "") + `Error imagen: ${err.message}`;
        if (c.copy) c.status = "copy_listo";
      }
    }

    saveCreativos(list);
    renderCreativos();
    renderSectionKpis();
  }

  if (bar) {
    const okCount = pending.filter((c) => c.status === "listo" || c.status === "copy_listo").length;
    bar.textContent = `Procesados ${okCount}/${pending.length} creativos.`;
    setTimeout(() => { bar.hidden = true; }, 5000);
  }
}

/* ── Descargar imagen generada ── */
async function downloadCreativoImage(id) {
  const c = getCreativos().find((x) => x.id === id);
  if (!c?.resultImageUrl) { alert("Este creativo no tiene imagen generada."); return; }
  try {
    const resp = await fetch(c.resultImageUrl);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `go_apple_${c.title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    window.open(c.resultImageUrl, "_blank");
  }
}

/* ── Config panel ── */
function mergeCreativosConfigFromGlobals() {
  const cfg = getCreativosConfig();
  let changed = false;
  const g = (key, field) => {
    const val = (window[key] || "").trim();
    if (val && cfg[field] !== val) { cfg[field] = val; changed = true; }
  };
  g("APP_NOTION_TOKEN", "notionToken");
  g("APP_NOTION_DB_ID", "notionDbId");
  g("APP_OPENAI_KEY", "openaiKey");
  g("APP_RAPIDAPI_KEY", "rapidapiKey");
  g("APP_IDEOGRAM_KEY", "ideogramKey");
  g("APP_APIFY_TOKEN", "apifyToken");
  g("APP_APIFY_HASHTAGS", "apifyHashtags");
  g("APP_APIFY_MIN_VIEWS", "apifyMinViews");
  if (changed) saveCreativosConfig(cfg);
}

function hydrateCreativosConfigForm() {
  mergeCreativosConfigFromGlobals();
  const cfg = getCreativosConfig();
  const el = (id) => document.getElementById(id);
  if (el("config-notion-token")) el("config-notion-token").value = cfg.notionToken || "";
  if (el("config-notion-db-id")) el("config-notion-db-id").value = cfg.notionDbId || "";
  if (el("config-openai-key")) el("config-openai-key").value = cfg.openaiKey || "";
  if (el("config-rapidapi-key")) el("config-rapidapi-key").value = cfg.rapidapiKey || "";
  if (el("config-ideogram-key")) el("config-ideogram-key").value = cfg.ideogramKey || "";
  if (el("config-apify-token")) el("config-apify-token").value = cfg.apifyToken || "";
  if (el("config-apify-hashtags")) el("config-apify-hashtags").value = cfg.apifyHashtags || "";
  if (el("config-apify-min-views")) el("config-apify-min-views").value = cfg.apifyMinViews || "";
  if (el("config-copy-prompt")) el("config-copy-prompt").value = cfg.copyPrompt || "";
  if (el("config-store-context")) el("config-store-context").value = cfg.storeContext || "";
  if (el("config-brand-name")) el("config-brand-name").value = cfg.brandName || "";
  if (el("config-brand-slogan")) el("config-brand-slogan").value = cfg.brandSlogan || "";
  if (el("config-brand-color")) el("config-brand-color").value = cfg.brandColor || "";
  if (el("config-brand-color-picker")) el("config-brand-color-picker").value = cfg.brandColor || "#7c3aed";
  if (el("config-brand-color2")) el("config-brand-color2").value = cfg.brandColor2 || "";
  if (el("config-brand-color2-picker")) el("config-brand-color2-picker").value = cfg.brandColor2 || "#22c55e";
  if (el("config-brand-style")) el("config-brand-style").value = cfg.brandStyle || "";
  if (el("config-brand-logo")) el("config-brand-logo").value = cfg.brandLogo || "";
  if (el("config-brand-design-notes")) el("config-brand-design-notes").value = cfg.brandDesignNotes || "";
  updateCreativosOpenAIStatus();
}

function saveCreativosConfigFromForm() {
  const el = (id) => document.getElementById(id);
  const existing = getCreativosConfig();
  const secretField = (inputId, field, globalKey) => {
    const v = (el(inputId)?.value || "").trim();
    if (v) return v;
    if (existing[field]) return existing[field];
    return (window[globalKey] || "").trim();
  };
  const cfg = {
    notionToken: secretField("config-notion-token", "notionToken", "APP_NOTION_TOKEN"),
    notionDbId: (el("config-notion-db-id")?.value || "").trim() || existing.notionDbId || "",
    openaiKey: secretField("config-openai-key", "openaiKey", "APP_OPENAI_KEY"),
    rapidapiKey: secretField("config-rapidapi-key", "rapidapiKey", "APP_RAPIDAPI_KEY"),
    ideogramKey: secretField("config-ideogram-key", "ideogramKey", "APP_IDEOGRAM_KEY"),
    apifyToken: secretField("config-apify-token", "apifyToken", "APP_APIFY_TOKEN"),
    apifyHashtags: (el("config-apify-hashtags")?.value || "").trim() || existing.apifyHashtags || "",
    apifyMinViews: (el("config-apify-min-views")?.value || "").trim() || existing.apifyMinViews || "",
    copyPrompt: (el("config-copy-prompt")?.value || "").trim(),
    storeContext: (el("config-store-context")?.value || "").trim(),
    brandName: (el("config-brand-name")?.value || "").trim(),
    brandSlogan: (el("config-brand-slogan")?.value || "").trim(),
    brandColor: (el("config-brand-color")?.value || "").trim(),
    brandColor2: (el("config-brand-color2")?.value || "").trim(),
    brandStyle: (el("config-brand-style")?.value || "").trim(),
    brandLogo: (el("config-brand-logo")?.value || "").trim(),
    brandDesignNotes: (el("config-brand-design-notes")?.value || "").trim(),
  };
  saveCreativosConfig(cfg);
  updateCreativosOpenAIStatus();
  const st = document.getElementById("creativos-config-status");
  if (st) { st.textContent = "Guardado."; setTimeout(() => { st.textContent = ""; }, 2000); }
}

/* ── File preview ── */
function setupCreativoRefFilePreview() {
  const fileInput = document.getElementById("creativo-ref-file");
  if (!fileInput) return;
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const urlInput = document.getElementById("creativo-ref-url");
      if (urlInput) urlInput.value = e.target.result;
      const preview = document.getElementById("creativo-ref-preview");
      const img = document.getElementById("creativo-ref-preview-img");
      if (preview && img) { img.src = e.target.result; preview.hidden = false; }
    };
    reader.readAsDataURL(file);
  });
}

function renderSectionKpis() {
  const el = (id) => document.getElementById(id);
  const mk = getDashboardMonthKey();
  const sales = getSales();
  const cash = getCash();
  const inventory = getInventory();

  // ─── Ventas ───
  const monthSales = salesForMonthKey(sales, mk);
  const ventasCount = monthSales.length;
  const ventasRevenue = monthSales.reduce((a, s) => a + numeric(s.saleTotal, 0), 0);
  const ventasUnits = monthSales.reduce((a, s) => a + numeric(s.quantity, 1), 0);
  const ventasProfitSummary = summarizeSalesProfit(monthSales);
  const hasCanje = ventasProfitSummary.tradeInReceived > 0;
  if (el("ventas-kpi-total")) el("ventas-kpi-total").textContent = String(ventasCount);
  if (el("ventas-kpi-revenue")) el("ventas-kpi-revenue").textContent = currency(ventasRevenue);
  if (el("ventas-kpi-units")) el("ventas-kpi-units").textContent = String(ventasUnits);

  const profitEl = el("ventas-kpi-profit");
  const resultadoCard = el("ventas-resultado-card");
  const breakdown = el("ventas-resultado-breakdown");
  const adj = ventasProfitSummary.adjustedProfit;

  if (profitEl) {
    profitEl.textContent = currency(adj);
    profitEl.classList.remove("ventas-resultado-card__value--pos", "ventas-resultado-card__value--neg");
    if (adj > 0.01) profitEl.classList.add("ventas-resultado-card__value--pos");
    else if (adj < -0.01) profitEl.classList.add("ventas-resultado-card__value--neg");
  }
  if (resultadoCard) {
    resultadoCard.classList.toggle("ventas-resultado-card--canje", hasCanje);
  }
  if (breakdown) breakdown.hidden = !hasCanje;

  const profitHint = el("ventas-kpi-profit-hint");
  if (profitHint) {
    profitHint.textContent = hasCanje
      ? "incluye equipos recibidos en canje"
      : "cobrado − costo del equipo";
  }

  const cashMarginEl = el("ventas-kpi-cash-margin");
  if (cashMarginEl) {
    const cm = ventasProfitSummary.cashMargin;
    cashMarginEl.textContent = currency(cm);
    cashMarginEl.classList.toggle("ventas-formula__v--info", hasCanje && cm < -0.01);
    cashMarginEl.classList.toggle("ventas-formula__v--neg", !hasCanje && cm < -0.01);
    cashMarginEl.classList.toggle("ventas-formula__v--pos", cm > 0.01);
  }

  const canjeVal = el("ventas-kpi-canje");
  if (canjeVal && hasCanje) canjeVal.textContent = currency(ventasProfitSummary.tradeInReceived);

  const profitInline = el("ventas-kpi-profit-inline");
  if (profitInline) {
    profitInline.textContent = currency(adj);
    profitInline.classList.toggle("ventas-formula__v--pos", adj > 0.01);
    profitInline.classList.toggle("ventas-formula__v--neg", adj < -0.01);
  }

  // ─── Caja ───
  const monthCash = cash.filter((c) => c.date && String(c.date).slice(0, 7) === mk);
  const cajaCashIn = monthCash.filter((c) => c.type === "ingreso").reduce((a, c) => a + numeric(c.amount, 0), 0);
  const cajaOut = monthCash.filter((c) => c.type === "egreso").reduce((a, c) => a + numeric(c.amount, 0), 0);
  const cajaTotalIn = ventasRevenue + cajaCashIn;
  if (el("caja-kpi-ingresos")) el("caja-kpi-ingresos").textContent = currency(cajaTotalIn);
  if (el("caja-kpi-egresos")) el("caja-kpi-egresos").textContent = currency(cajaOut);
  if (el("caja-kpi-count")) el("caja-kpi-count").textContent = `${ventasCount} + ${monthCash.length}`;
  if (el("caja-kpi-balance")) el("caja-kpi-balance").textContent = currency(cajaTotalIn - cajaOut);

  // ─── Garantías (todas; no filtra por período) ───
  const warrantySales = sales.slice();
  let gActive = 0;
  let gExpired = 0;
  let gTotal = 0;
  for (const s of warrantySales) {
    if (!s.date) continue;
    gTotal++;
    if (warrantyDaysRemaining(s.date) >= 0) gActive++;
    else gExpired++;
  }
  const gTech = inventory.filter((i) => i.flagTecnico && numeric(i.stock, 0) > 0).length;
  if (el("garantias-kpi-active")) el("garantias-kpi-active").textContent = String(gActive);
  if (el("garantias-kpi-expired")) el("garantias-kpi-expired").textContent = String(gExpired);
  if (el("garantias-kpi-total")) el("garantias-kpi-total").textContent = String(gTotal);
  if (el("garantias-kpi-tech")) el("garantias-kpi-tech").textContent = String(gTech);

  // ─── Pipeline (todos los leads) ───
  const leads = getPipelineLeads();
  const pActive = leads.filter((l) => l.stage !== "venta" && l.stage !== "perdido").length;
  const pWon = leads.filter((l) => l.stage === "venta").length;
  const pLost = leads.filter((l) => l.stage === "perdido").length;
  if (el("pipeline-kpi-total")) el("pipeline-kpi-total").textContent = String(leads.length);
  if (el("pipeline-kpi-active")) el("pipeline-kpi-active").textContent = String(pActive);
  if (el("pipeline-kpi-won")) el("pipeline-kpi-won").textContent = String(pWon);
  if (el("pipeline-kpi-lost")) el("pipeline-kpi-lost").textContent = String(pLost);

  // ─── Deudores (todos los pendientes) ───
  const recv = getReceivables();
  const deudaTotal = recv.reduce((a, r) => a + Math.max(0, numeric(r.amountPending, 0)), 0);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = recv.filter((r) => r.dueDate && r.dueDate < today && numeric(r.amountPending, 0) > 0).length;
  const futureDates = recv
    .map((r) => r.dueDate)
    .filter((d) => d && d >= today)
    .sort();
  const nextDue = futureDates.length > 0 ? futureDates[0] : "—";
  if (el("deudores-kpi-total")) el("deudores-kpi-total").textContent = currency(deudaTotal);
  if (el("deudores-kpi-count")) el("deudores-kpi-count").textContent = String(recv.length);
  if (el("deudores-kpi-overdue")) el("deudores-kpi-overdue").textContent = String(overdue);
  if (el("deudores-kpi-next")) el("deudores-kpi-next").textContent = nextDue;

  // ─── Facturación ───
  const invoices = getInvoices();
  const invMonth = invoices.filter((inv) => {
    const d = inv.issueDate || inv.createdAt || "";
    return String(d).slice(0, 7) === mk;
  });
  const invRevenue = invMonth
    .filter((inv) => inv.status !== "anulado")
    .reduce((a, inv) => a + numeric(inv.total, 0), 0);
  const invVoided = invoices.filter((inv) => inv.status === "anulado" || inv.invoiceType === "nota_credito").length;
  if (el("fact-kpi-count")) el("fact-kpi-count").textContent = String(invMonth.length);
  if (el("fact-kpi-month")) el("fact-kpi-month").textContent = String(invMonth.length);
  if (el("fact-kpi-revenue")) el("fact-kpi-revenue").textContent = currency(invRevenue);
  if (el("fact-kpi-voided")) el("fact-kpi-voided").textContent = String(invVoided);

  // ─── Inventario ───
  const inStock = inventory.filter((i) => numeric(i.stock, 0) > 0);
  const invUnits = inStock.reduce((a, i) => a + numeric(i.stock, 0), 0);
  const modelKeys = new Set(inStock.map((i) => inventoryModelGroupKey(i.model)));
  const invValue = inStock.reduce((a, i) => a + numeric(i.stock, 0) * numeric(i.price, numeric(i.cost, 0)), 0);
  const invCostTotal = inStock.reduce((a, i) => a + numeric(i.stock, 0) * numeric(i.cost, 0), 0);
  if (el("inv-kpi-units")) el("inv-kpi-units").textContent = String(invUnits);
  if (el("inv-kpi-models")) el("inv-kpi-models").textContent = String(modelKeys.size);
  if (el("inv-kpi-value")) el("inv-kpi-value").textContent = currency(invValue);
  if (el("inv-kpi-cost")) el("inv-kpi-cost").textContent = currency(invCostTotal);

  // ─── Creativos (todos) ───
  const creativos = getCreativos();
  const crPending = creativos.filter((c) => c.status === "pendiente" || c.status === "referencia").length;
  const crReady = creativos.filter((c) => c.status === "listo" || c.status === "copy_listo" || c.status === "imagen_lista").length;
  const crPublished = creativos.filter((c) => c.status === "publicado").length;
  if (el("creativos-kpi-total")) el("creativos-kpi-total").textContent = String(creativos.length);
  if (el("creativos-kpi-pending")) el("creativos-kpi-pending").textContent = String(crPending);
  if (el("creativos-kpi-ready")) el("creativos-kpi-ready").textContent = String(crReady);
  if (el("creativos-kpi-published")) el("creativos-kpi-published").textContent = String(crPublished);
}

function renderDashboard() {
  const sales = getSales();
  const cash = getCash();
  const inventory = getInventory();
  const mk = getDashboardMonthKey();

  const salesTotal = salesForMonthKey(sales, mk).reduce((sum, s) => sum + numeric(s.saleTotal, 0), 0);

  const moneyIn = totalMoneyInForMonth(sales, cash, mk);
  const moneyOut = sumCashEgresosMonth(cash, mk);
  const businessProfit = monthBusinessResult(sales, cash, mk);
  const totalStock = inventory.reduce((sum, item) => sum + item.stock, 0);
  const stockValue = inventory.reduce((sum, item) => sum + item.stock * numeric(item.price, numeric(item.cost, 0)), 0);

  const warrantyActiveCount = warrantyActiveCountForSalesInMonth(sales, mk);
  const pendingSum = sumPendingReceivables();

  setKpiMoneyText(kpiEntra, moneyIn);
  setKpiMoneyText(kpiSale, moneyOut);
  setKpiMoneyText(kpiGanancia, businessProfit - monthlyStoreCostTotal());
  setKpiMoneyText(kpiVentas, salesTotal);
  kpiStock.textContent = String(totalStock);
  setKpiMoneyText(kpiStockValue, stockValue);
  if (kpiWarrantyActive) kpiWarrantyActive.textContent = String(warrantyActiveCount);
  if (kpiCuotasCobrar) setKpiMoneyText(kpiCuotasCobrar, pendingSum);

  const split = getProfitSplitPercents();
  const profitForSplit = monthProfitForSplit(sales, cash, mk);
  const parts = splitProfitByPercents(profitForSplit, split);
  const totalSplit = splitProfitByPercents(sumCashEgresosByDestMonth(cash, mk, "total"), split);
  const reservaDirect =
    sumCashIngresosByDestMonth(cash, mk, "reserva") -
    sumCashEgresosReservaMonth(cash, mk) -
    totalSplit.reserva;
  const restockDirect =
    sumCashIngresosByDestMonth(cash, mk, "restock") -
    sumCashEgresosByDestMonth(cash, mk, "restock") -
    totalSplit.restock;
  const sociosDirect =
    sumCashIngresosByDestMonth(cash, mk, "socios") -
    sumCashEgresosByDestMonth(cash, mk, "socios") -
    totalSplit.socios;
  if (kpiReserva) setKpiMoneyText(kpiReserva, parts.reserva + reservaDirect);
  if (kpiRestock) setKpiMoneyText(kpiRestock, parts.restock + restockDirect);
  if (kpiSocios) setKpiMoneyText(kpiSocios, parts.socios + sociosDirect);
  if (kpiPctReserva) kpiPctReserva.textContent = `${split.reservePct}%`;
  if (kpiPctRestock) kpiPctRestock.textContent = `${split.middlePct}%`;
  if (kpiPctSocios) kpiPctSocios.textContent = `${split.partnersPct}%`;

  hydrateGoalsFormOnce();
  renderGoalsProgress();
}

function getProfitSplitPercents() {
  const g = readGoals();
  let r = Number(g.reservePct);
  let m = Number(g.middlePct);
  let p = Number(g.partnersPct);
  if (!Number.isFinite(r)) r = DEFAULT_GOALS.reservePct;
  if (!Number.isFinite(m)) m = DEFAULT_GOALS.middlePct;
  if (!Number.isFinite(p)) p = DEFAULT_GOALS.partnersPct;
  r = Math.max(0, r);
  m = Math.max(0, m);
  p = Math.max(0, p);
  const sum = r + m + p;
  if (sum <= 0) {
    return {
      reservePct: DEFAULT_GOALS.reservePct,
      middlePct: DEFAULT_GOALS.middlePct,
      partnersPct: DEFAULT_GOALS.partnersPct,
    };
  }
  if (Math.abs(sum - 100) > 0.01) {
    return {
      reservePct: Math.round((r / sum) * 1000) / 10,
      middlePct: Math.round((m / sum) * 1000) / 10,
      partnersPct: Math.round((p / sum) * 1000) / 10,
    };
  }
  return { reservePct: r, middlePct: m, partnersPct: p };
}

function splitProfitByPercents(profit, split) {
  const f = numeric(profit, 0);
  return {
    reserva: (f * split.reservePct) / 100,
    restock: (f * split.middlePct) / 100,
    socios: (f * split.partnersPct) / 100,
  };
}

function mergeCloudDolarIntoLocalStorageGoals() {
  if (!cacheCrmSettings) return;
  try {
    const raw = localStorage.getItem(KEYS.goals);
    const o = raw ? { ...DEFAULT_GOALS, ...JSON.parse(raw) } : { ...DEFAULT_GOALS };
    delete o.restockPct;
    const v = Number(cacheCrmSettings.dolarBlueArsPerUsd);
    o.dolarBlueArsPerUsd = Number.isFinite(v) && v >= 0 ? v : 0;
    localStorage.setItem(KEYS.goals, JSON.stringify(o));
  } catch (_) {
    /* — */
  }
}

/** Persiste dólar blue en `crm_settings` (solo con sesión Supabase). */
async function saveCrmSettingsDolarToCloud(dolarBlueArsPerUsd) {
  if (!useCloud || !supabaseClient) return;
  const val =
    Number.isFinite(dolarBlueArsPerUsd) && dolarBlueArsPerUsd >= 0
      ? Math.round(dolarBlueArsPerUsd * 100) / 100
      : 0;
  try {
    const userId = await getUserId();
    const { error } = await supabaseClient.from("crm_settings").upsert(
      {
        user_id: userId,
        dolar_blue_ars_per_usd: val,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    cacheCrmSettings = { dolarBlueArsPerUsd: val };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    alert(m || "No se pudo guardar la cotización en Supabase. Ejecutá CRM/supabase/migration_crm_settings.sql en el panel SQL.");
  }
}

/** Recalcula price_ars / cuotas en DB para todas las filas (p. ej. tras cambiar el dólar blue). */
async function cloudRecomputeAllInventoryArsForUser() {
  if (!useCloud || !supabaseClient) return;
  try {
    const userId = await getUserId();
    const rows = getInventory();
    const ts = new Date().toISOString();
    const results = await Promise.all(
      rows.map((item) => {
        const f = computeInventoryArsFields(item.price);
        return supabaseClient
          .from("inventory_items")
          .update({
            price_ars: f.price_ars,
            cuota_3_ars: f.cuota_3_ars,
            cuota_6_ars: f.cuota_6_ars,
            cuota_12_ars: f.cuota_12_ars,
            cuota_18_ars: f.cuota_18_ars,
            updated_at: ts,
          })
          .eq("id", item.id)
          .eq("user_id", userId);
      })
    );
    const err = results.find((r) => r.error)?.error;
    if (err) throw err;
  } catch (e) {
    console.warn("Recompute ARS inventario:", e);
  }
}

function readGoals() {
  try {
    const raw = localStorage.getItem(KEYS.goals);
    const base = raw
      ? (() => {
          const o = { ...DEFAULT_GOALS, ...JSON.parse(raw) };
          delete o.restockPct;
          return o;
        })()
      : { ...DEFAULT_GOALS };
    if (useCloud && cacheCrmSettings != null) {
      const v = Number(cacheCrmSettings.dolarBlueArsPerUsd);
      if (Number.isFinite(v) && v >= 0) {
        base.dolarBlueArsPerUsd = v;
      }
    }
    return base;
  } catch {
    return { ...DEFAULT_GOALS };
  }
}

function writeGoals(partial) {
  const next = { ...readGoals(), ...partial };
  localStorage.setItem(KEYS.goals, JSON.stringify(next));
}

function defaultStoreCosts() {
  return [
    { id: "alquiler", name: "Alquiler", amount: 0 },
    { id: "luz", name: "Luz", amount: 0 },
    { id: "internet", name: "Internet", amount: 0 },
  ];
}

function normalizeStoreCosts(raw) {
  if (!Array.isArray(raw)) return defaultStoreCosts();
  return raw.map((cost, index) => ({
    id: String(cost?.id || `costo-${index}`),
    name: String(cost?.name ?? ""),
    amount: Math.max(0, numeric(cost?.amount, 0)),
  }));
}

function monthlyStoreCostTotal(goals = readGoals()) {
  const list = Array.isArray(goals?.storeCosts) ? goals.storeCosts : [];
  return list.reduce((sum, cost) => sum + Math.max(0, numeric(cost?.amount, 0)), 0);
}

function readStoreCostsFromForm() {
  return [...document.querySelectorAll("#store-costs-list .store-cost-row")].map((row) => ({
    id: row.dataset.id || crypto.randomUUID(),
    name: row.querySelector("[data-cost-name]")?.value.trim() || "Costo",
    amount: Math.max(0, numeric(row.querySelector("[data-cost-amount]")?.value, 0)),
  }));
}

function updateStoreCostsTotal() {
  const totalEl = document.getElementById("store-costs-total");
  if (!totalEl) return;
  const total = readStoreCostsFromForm().reduce((sum, cost) => sum + cost.amount, 0);
  totalEl.innerHTML = `Por mes hay que cubrir <strong>${escapeHtml(currency(total))}</strong> para recién ver ganancia.`;
}

function renderStoreCostRows(costs) {
  const list = document.getElementById("store-costs-list");
  if (!list) return;
  list.innerHTML = normalizeStoreCosts(costs)
    .map(
      (cost) => `<div class="store-cost-row" data-id="${escapeHtml(cost.id)}">
        <label>Concepto
          <input data-cost-name type="text" value="${escapeHtml(cost.name)}" />
        </label>
        <label>USD por mes
          <input data-cost-amount type="number" min="0" step="0.01" value="${cost.amount ? String(cost.amount) : ""}" placeholder="0" />
        </label>
        <button type="button" class="secondary store-cost-remove">Quitar</button>
      </div>`
    )
    .join("");
  updateStoreCostsTotal();
}

function hydrateGoalsFormOnce() {
  if (goalsFormHydrated) return;
  const g = readGoals();
  const inc = document.getElementById("goal-income");
  const pr = document.getElementById("goal-profit");
  const un = document.getElementById("goal-units");
  const sr = document.getElementById("split-reserve-pct");
  const sm = document.getElementById("split-middle-pct");
  const sp = document.getElementById("split-partners-pct");
  const db = document.getElementById("goal-dolar-blue");
  if (inc) inc.value = g.incomeMonthlyUsd > 0 ? String(g.incomeMonthlyUsd) : "";
  if (pr) pr.value = g.profitMonthlyUsd > 0 ? String(g.profitMonthlyUsd) : "";
  if (un) un.value = g.unitsMonthly > 0 ? String(g.unitsMonthly) : "";
  if (db) {
    const d = Number(g.dolarBlueArsPerUsd);
    db.value = Number.isFinite(d) && d > 0 ? String(d) : "";
  }
  if (sr) sr.value = String(g.reservePct ?? DEFAULT_GOALS.reservePct);
  if (sm) sm.value = String(g.middlePct ?? DEFAULT_GOALS.middlePct);
  if (sp) sp.value = String(g.partnersPct ?? DEFAULT_GOALS.partnersPct);
  renderStoreCostRows(g.storeCosts);
  goalsFormHydrated = true;
}

function sumCashIngresosMonth(cash, keyYYYYMM) {
  return cashIngresosForMonthKey(cash, keyYYYYMM).reduce((a, c) => a + numeric(c.amount, 0), 0);
}

function cashEgresosForMonthKey(cash, keyYYYYMM) {
  return cash.filter(
    (c) =>
      c.type === "egreso" && c.date && String(c.date).length >= 7 && String(c.date).slice(0, 7) === keyYYYYMM
  );
}

function sumCashEgresosMonth(cash, keyYYYYMM) {
  return cashEgresosForMonthKey(cash, keyYYYYMM).reduce((a, c) => a + numeric(c.amount, 0), 0);
}

/** `operativo` | `restock` | `tecnico` en egresos legacy; ingresos → operativo (no aplica). */
function cashEgresoKindOf(item) {
  return repartoDestToEgresoKind(cashRepartoDestOf(item));
}

function sumCashIngresosByDestMonth(cash, keyYYYYMM, dest) {
  return cashIngresosForMonthKey(cash, keyYYYYMM)
    .filter((c) => cashRepartoDestOf(c) === dest)
    .reduce((a, c) => a + numeric(c.amount, 0), 0);
}

function sumCashEgresosByDestMonth(cash, keyYYYYMM, dest) {
  return cashEgresosForMonthKey(cash, keyYYYYMM)
    .filter((c) => cashRepartoDestOf(c) === dest)
    .filter((c) => !isCommissionCashMovement(c))
    .reduce((a, c) => a + numeric(c.amount, 0), 0);
}

function sumCashEgresosReservaMonth(cash, keyYYYYMM) {
  return cashEgresosForMonthKey(cash, keyYYYYMM)
    .filter((c) => {
      const d = cashRepartoDestOf(c);
      return d === "reserva" || d === "tecnico";
    })
    .filter((c) => !isCommissionCashMovement(c))
    .reduce((a, c) => a + numeric(c.amount, 0), 0);
}

function sumCashRestockEgresosMonth(cash, keyYYYYMM) {
  return sumCashEgresosByDestMonth(cash, keyYYYYMM, "restock");
}

function isCommissionCashMovement(item) {
  return String(item?.concept || "").startsWith(COMISION_VENTA_PREFIX);
}

/** Comisión de una línea de venta (guardada o recalculada si falta). */
function saleCommissionAmount(sale) {
  const sid = sale.sellerId ?? sale.seller_id;
  if (!sid) return 0;
  const stored = numeric(sale.commissionAmount ?? sale.commission_amount, NaN);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  return computeSaleCommission(String(sid), numeric(sale.saleTotal, 0)).commissionAmount;
}

function sumSellerCommissionsForMonth(sales, keyYYYYMM) {
  return salesForMonthKey(sales, keyYYYYMM).reduce((sum, s) => sum + saleCommissionAmount(s), 0);
}

function sumCashOperativoEgresosMonth(cash, keyYYYYMM) {
  return sumCashEgresosReservaMonth(cash, keyYYYYMM);
}

function syncCashEgresoKindUi() {
  syncCashRepartoDestUi();
}

/**
 * Base para el reparto Reserva / Restock / Socios: ventas + ingresos «Reparto general», menos comisiones.
 * Ingresos/egresos con destino fijo van directo al bucket correspondiente.
 */
function monthProfitForSplit(sales, cash, keyYYYYMM) {
  const salesTotal = salesForMonthKey(sales, keyYYYYMM).reduce((a, s) => a + numeric(s.saleTotal, 0), 0);
  const repartoCashIn = sumCashIngresosByDestMonth(cash, keyYYYYMM, "reparto");
  const commissions = sumSellerCommissionsForMonth(sales, keyYYYYMM);
  return Math.max(0, salesTotal + repartoCashIn - commissions);
}

/** Facturación ventas + ingresos de caja del mes. */
function totalMoneyInForMonth(sales, cash, keyYYYYMM) {
  const sv = salesForMonthKey(sales, keyYYYYMM).reduce((a, s) => a + numeric(s.saleTotal, 0), 0);
  return sv + sumCashIngresosMonth(cash, keyYYYYMM);
}

/** Resultado del mes: todo lo que entró (ventas + ingresos caja) − egresos de caja. */
function monthBusinessResult(sales, cash, keyYYYYMM) {
  return totalMoneyInForMonth(sales, cash, keyYYYYMM) - sumCashEgresosMonth(cash, keyYYYYMM);
}

function unitsSoldInMonth(sales, keyYYYYMM) {
  return salesForMonthKey(sales, keyYYYYMM).reduce((a, s) => a + numeric(s.quantity, 0), 0);
}

function renderGoalsProgress() {
  const wrap = document.getElementById("goals-progress");
  if (!wrap) return;
  const g = readGoals();
  const sales = getSales();
  const cash = getCash();
  const periodKey = getDashboardMonthKey();
  const monthLabel = monthKeyToLabel(periodKey);

  const actualIn = totalMoneyInForMonth(sales, cash, periodKey);
  const actualRes = monthBusinessResult(sales, cash, periodKey);
  const overhead = monthlyStoreCostTotal(g);
  const actualUnits = unitsSoldInMonth(sales, periodKey);

  const rows = [];
  if (overhead > 0) {
    const covered = actualRes > 0 ? Math.min(100, (actualRes / overhead) * 100) : 0;
    rows.push({
      label: "Costos de la tienda",
      sub: `Hay que cubrir ${currency(overhead)} por mes. Ganancia después de eso: ${currency(actualRes - overhead)} · ${monthLabel}`,
      pct: covered,
    });
  }
  if (g.incomeMonthlyUsd > 0) {
    const pct = Math.min(100, (actualIn / g.incomeMonthlyUsd) * 100);
    rows.push({
      label: "Ingresos (ventas + caja)",
      sub: `${currency(actualIn)} de ${currency(g.incomeMonthlyUsd)} · ${monthLabel}`,
      pct,
    });
  }
  if (g.profitMonthlyUsd > 0) {
    const pct = Math.min(100, (actualRes / g.profitMonthlyUsd) * 100);
    rows.push({
      label: "Resultado del mes",
      sub: `${currency(actualRes)} de ${currency(g.profitMonthlyUsd)} · ${monthLabel}`,
      pct,
    });
  }
  if (g.unitsMonthly > 0) {
    const pct = Math.min(100, (actualUnits / g.unitsMonthly) * 100);
    rows.push({
      label: "Unidades vendidas",
      sub: `${actualUnits} de ${g.unitsMonthly} · ${monthLabel}`,
      pct,
    });
  }

  if (rows.length === 0) {
    wrap.innerHTML =
      '<p class="goals-progress-empty muted">Configurá montos arriba y guardá para ver el avance vs el mes del selector de período.</p>';
    return;
  }

  wrap.innerHTML = rows
    .map(
      (r) => `
    <div class="goals-progress-row">
      <div class="goals-progress-label">
        <span>${escapeHtml(r.label)}</span>
        <span class="muted goals-progress-sub">${escapeHtml(r.sub)}</span>
      </div>
      <div class="goals-progress-track" role="progressbar" aria-valuenow="${Math.round(r.pct)}" aria-valuemin="0" aria-valuemax="100">
        <div class="goals-progress-fill" style="width:${r.pct}%"></div>
      </div>
      <span class="goals-progress-pct">${r.pct.toFixed(0)}%</span>
    </div>`
    )
    .join("");
}

function monthKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthKeyPrevious(keyYYYYMM) {
  const [y, m] = keyYYYYMM.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return monthKeyFromDate(d);
}

function monthKeyToLabel(keyYYYYMM) {
  const [y, m] = keyYYYYMM.split("-").map(Number);
  const lab = new Date(y, m - 1, 1).toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  return lab.charAt(0).toUpperCase() + lab.slice(1);
}

function getDashboardMonthKey() {
  const sel = document.getElementById("dashboard-month");
  if (sel && sel.value && /^\d{4}-\d{2}$/.test(sel.value)) return sel.value;
  try {
    const stored = localStorage.getItem(KEYS.dashboardMonth);
    if (stored && /^\d{4}-\d{2}$/.test(stored)) return stored;
  } catch (_) {
    /* — */
  }
  return monthKeyFromDate(new Date());
}

function persistDashboardMonth(key) {
  try {
    localStorage.setItem(KEYS.dashboardMonth, key);
  } catch (_) {
    /* — */
  }
}

const DASHBOARD_MONTH_RANGE = 24;

function populateDashboardMonthSelect() {
  const sel = document.getElementById("dashboard-month");
  if (!sel) return;
  const keep = sel.value || localStorage.getItem(KEYS.dashboardMonth) || getDashboardMonthKey();
  sel.innerHTML = "";
  const now = new Date();
  for (let i = 0; i < DASHBOARD_MONTH_RANGE; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKeyFromDate(d);
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = monthKeyToLabel(key);
    sel.appendChild(opt);
  }
  const ok = [...sel.options].some((o) => o.value === keep);
  sel.value = ok ? keep : monthKeyFromDate(now);
  persistDashboardMonth(sel.value);
}

/** Para garantías: “hoy” si el mes elegido es el actual; si no, último día del mes. */
function getAsOfDateForMonthKey(monthKey) {
  const now = new Date();
  const curKey = monthKeyFromDate(now);
  const [y, m] = monthKey.split("-").map(Number);
  const endOfMonth = new Date(y, m, 0);
  endOfMonth.setHours(0, 0, 0, 0);
  if (monthKey === curKey) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    today.setHours(0, 0, 0, 0);
    return today.getTime() <= endOfMonth.getTime() ? today : endOfMonth;
  }
  return endOfMonth;
}

function warrantyActiveCountForSalesInMonth(sales, monthKey) {
  const asOf = getAsOfDateForMonthKey(monthKey);
  const monthSales = salesForMonthKey(sales, monthKey);
  return monthSales.filter((s) => {
    const endStr = warrantyEndDateStr(s.date);
    const [ey, em, ed] = endStr.split("-").map(Number);
    const endW = new Date(ey, em - 1, ed);
    endW.setHours(0, 0, 0, 0);
    return endW >= asOf;
  }).length;
}

function salesForMonthKey(sales, keyYYYYMM) {
  return sales.filter((s) => s.date && String(s.date).length >= 7 && String(s.date).slice(0, 7) === keyYYYYMM);
}

const VIEW_FILTER_DEFAULTS = {
  sales: { showAllMonths: false, q: "" },
  cash: { showAllMonths: false, q: "", type: "", dest: "" },
  invoices: { showAllMonths: true, q: "", status: "" },
  receivables: { showAllMonths: true, q: "", kind: "" },
  pipeline: { showAllMonths: true, q: "", source: "" },
  warranty: { showAllMonths: true, q: "", status: "active" },
  creativos: { showAllMonths: true, q: "" },
  inventory: { q: "", stock: "all", ingresoMonth: false },
};

/** Solo ventas y caja filtran por el período global; el resto muestra todo por defecto. */
const MONTH_FILTERED_VIEWS = new Set(["sales", "cash"]);

function readAllViewFilters() {
  try {
    const raw = localStorage.getItem(KEYS.viewFilters);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function readViewFilters(viewId) {
  const all = readAllViewFilters();
  const base = VIEW_FILTER_DEFAULTS[viewId] || {};
  return { ...base, ...(all[viewId] || {}) };
}

function writeViewFilters(viewId, patch) {
  const all = readAllViewFilters();
  all[viewId] = { ...readViewFilters(viewId), ...patch };
  try {
    localStorage.setItem(KEYS.viewFilters, JSON.stringify(all));
  } catch (_) {
    /* — */
  }
}

function recordInMonth(dateLike, monthKey) {
  if (!dateLike || !monthKey) return false;
  return String(dateLike).length >= 7 && String(dateLike).slice(0, 7) === monthKey;
}

function viewLimitsToActiveMonth(viewId) {
  if (!MONTH_FILTERED_VIEWS.has(viewId)) return false;
  const vf = readViewFilters(viewId);
  return vf.showAllMonths !== true;
}

function filterRowsByActiveMonth(rows, viewId, dateAccessor) {
  if (!viewLimitsToActiveMonth(viewId)) return rows;
  const mk = getDashboardMonthKey();
  return rows.filter((row) => recordInMonth(dateAccessor(row), mk));
}

function textIncludesQuery(haystack, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return true;
  return String(haystack || "").toLowerCase().includes(needle);
}

function updatePeriodBarNote() {
  const note = document.getElementById("app-period-bar-note");
  if (!note) return;
  const mk = getDashboardMonthKey();
  note.textContent = `${monthKeyToLabel(mk)} — Ventas y Caja filtran por este mes. Inventario, deudores, técnico y el resto muestran todo.`;
  document.querySelectorAll("[data-view-period-label]").forEach((el) => {
    el.textContent = monthKeyToLabel(mk);
  });
}

function bindViewFilterControls() {
  const rerender = (names) => {
    if (names.includes("renderSectionKpis")) renderSectionKpis();
    if (names.includes("renderSales")) renderSales();
    if (names.includes("renderCash")) renderCash();
    if (names.includes("renderInvoices")) renderInvoices();
    if (names.includes("renderReceivables")) renderReceivables();
    if (names.includes("renderPipeline")) renderPipeline();
    if (names.includes("renderWarranties")) renderWarranties();
    if (names.includes("renderCreativos")) renderCreativos();
    if (names.includes("renderInventory")) renderInventory();
  };

  const specs = [
    { view: "sales", q: "sales-filter-q", all: "sales-filter-all-months", renders: ["renderSales"] },
    {
      view: "cash",
      q: "cash-filter-q",
      all: "cash-filter-all-months",
      type: "cash-filter-type",
      dest: "cash-filter-dest",
      renders: ["renderCash"],
    },
    {
      view: "invoices",
      q: "invoices-filter-q",
      all: "invoices-filter-all-months",
      status: "invoices-filter-status",
      renders: ["renderInvoices"],
    },
    {
      view: "receivables",
      q: "receivables-filter-q",
      all: "receivables-filter-all-months",
      kind: "receivables-filter-kind",
      renders: ["renderReceivables", "renderSectionKpis"],
    },
    {
      view: "pipeline",
      q: "pipeline-filter-q",
      all: "pipeline-filter-all-months",
      source: "pipeline-filter-source",
      renders: ["renderPipeline", "renderSectionKpis"],
    },
    {
      view: "warranty",
      q: "warranty-search",
      all: "warranty-filter-all-months",
      status: "warranty-filter",
      renders: ["renderWarranties", "renderSectionKpis"],
    },
    {
      view: "creativos",
      q: "creativos-filter-q",
      all: "creativos-filter-all-months",
      renders: ["renderCreativos", "renderSectionKpis"],
    },
    {
      view: "inventory",
      q: "inv-stock-search",
      stock: "inv-stock-filter",
      ingresoMonth: "inventory-filter-ingreso-month",
      renders: ["renderInventory"],
    },
  ];

  for (const spec of specs) {
    const vf = readViewFilters(spec.view);
    if (spec.q) {
      const el = document.getElementById(spec.q);
      if (el && el.dataset.viewFilterBound !== "1") {
        el.dataset.viewFilterBound = "1";
        if (el.value === "" && vf.q) el.value = vf.q;
        el.addEventListener("input", () => {
          writeViewFilters(spec.view, { q: el.value });
          rerender(spec.renders);
        });
      }
    }
    if (spec.all && MONTH_FILTERED_VIEWS.has(spec.view)) {
      const el = document.getElementById(spec.all);
      if (el && el.dataset.viewFilterBound !== "1") {
        el.dataset.viewFilterBound = "1";
        el.checked = vf.showAllMonths === true;
        el.addEventListener("change", () => {
          writeViewFilters(spec.view, { showAllMonths: el.checked });
          renderAll();
        });
      }
    }
    for (const key of ["type", "dest", "status", "kind", "source", "stock"]) {
      const id = spec[key];
      if (!id) continue;
      const el = document.getElementById(id);
      if (el && el.dataset.viewFilterBound !== "1") {
        el.dataset.viewFilterBound = "1";
        if (vf[key] && el.value !== vf[key]) el.value = vf[key];
        el.addEventListener("change", () => {
          const patch = {};
          patch[key] = el.value;
          writeViewFilters(spec.view, patch);
          rerender(spec.renders);
        });
      }
    }
    if (spec.ingresoMonth) {
      const el = document.getElementById(spec.ingresoMonth);
      if (el && el.dataset.viewFilterBound !== "1") {
        el.dataset.viewFilterBound = "1";
        el.checked = vf.ingresoMonth === true;
        el.addEventListener("change", () => {
          writeViewFilters(spec.view, { ingresoMonth: el.checked });
          renderInventory();
        });
      }
    }
  }
}

function renderViewFilterEmptyRow(tbody, colspan, viewId, entityLabel) {
  if (!tbody) return;
  tbody.innerHTML = "";
  const tr = document.createElement("tr");
  const mk = monthKeyToLabel(getDashboardMonthKey());
  const allMonths = !viewLimitsToActiveMonth(viewId);
  tr.innerHTML = `<td colspan="${colspan}" class="muted">No hay ${escapeHtml(entityLabel)}${
    allMonths || !MONTH_FILTERED_VIEWS.has(viewId)
      ? " con estos filtros."
      : ` en <strong>${escapeHtml(mk)}</strong>. Probá «Ver todos los meses» o cambiá el período arriba.`
  }</td>`;
  tbody.appendChild(tr);
}

function cashIngresosForMonthKey(cash, keyYYYYMM) {
  return cash.filter(
    (c) =>
      c.type === "ingreso" && c.date && String(c.date).length >= 7 && String(c.date).slice(0, 7) === keyYYYYMM
  );
}

function formatDeltaPct(cur, prev) {
  if (prev <= 0 && cur <= 0) return { text: "", cls: "" };
  if (prev <= 0) {
    return { text: "↑ vs mes pasado (el mes anterior estaba en $0).", cls: "stats-delta--up" };
  }
  const pct = ((cur - prev) / prev) * 100;
  const arrow = pct >= 0 ? "↑" : "↓";
  const cls = pct >= 0 ? "stats-delta--up" : "stats-delta--down";
  return { text: `${arrow} ${Math.abs(pct).toFixed(1)}% vs mes pasado`, cls };
}

function renderStatsVisual() {
  const dashSel = document.getElementById("dashboard-month");
  if (dashSel && dashSel.options.length === 0) {
    populateDashboardMonthSelect();
  }

  const sales = getSales();
  const cash = getCash();
  const focusKey = getDashboardMonthKey();
  const prevKey = monthKeyPrevious(focusKey);

  const sumTot = (arr) => arr.reduce((a, s) => a + numeric(s.saleTotal, 0), 0);

  const cTot = totalMoneyInForMonth(sales, cash, focusKey);
  const pTot = totalMoneyInForMonth(sales, cash, prevKey);
  const cPr = monthBusinessResult(sales, cash, focusKey);
  const pPr = monthBusinessResult(sales, cash, prevKey);

  const el = (id) => document.getElementById(id);
  if (el("stat-sales-current")) el("stat-sales-current").textContent = currency(cTot);
  if (el("stat-sales-prev")) el("stat-sales-prev").textContent = currency(pTot);
  if (el("stat-profit-current")) el("stat-profit-current").textContent = currency(cPr);
  if (el("stat-profit-prev")) el("stat-profit-prev").textContent = currency(pPr);

  const maxInBar = Math.max(cTot, pTot, 1);
  const wCurIn = (cTot / maxInBar) * 100;
  const wPrevIn = (pTot / maxInBar) * 100;
  if (el("stat-sales-bar-current")) el("stat-sales-bar-current").style.width = `${wCurIn}%`;
  if (el("stat-sales-bar-prev")) el("stat-sales-bar-prev").style.width = `${wPrevIn}%`;

  const focusLabel = monthKeyToLabel(focusKey);
  const prevLabelOnly = monthKeyToLabel(prevKey);
  if (el("stat-label-current")) {
    el("stat-label-current").textContent = focusLabel;
  }
  if (el("stat-label-prev")) {
    el("stat-label-prev").textContent = `Mes anterior · ${prevLabelOnly}`;
  }
  if (el("stat-label-profit-focus")) {
    el("stat-label-profit-focus").textContent = focusLabel;
  }
  if (el("stat-label-profit-prev")) {
    el("stat-label-profit-prev").textContent = `Mes anterior · ${prevLabelOnly}`;
  }

  const dIn = formatDeltaPct(cTot, pTot);
  const dRes = formatDeltaPct(cPr, pPr);
  const sd = el("stat-sales-delta");
  if (sd) {
    sd.textContent = dIn.text || "";
    sd.className = `stats-delta ${dIn.cls || ""}`;
  }
  const pd = el("stat-profit-delta");
  if (pd) {
    pd.textContent = dRes.text || "";
    pd.className = `stats-delta ${dRes.cls || ""}`;
  }

  const chartKey = focusKey;
  const [yStr, mStr] = chartKey.split("-");
  const chartY = Number(yStr);
  const chartM = Number(mStr);
  const dim = new Date(chartY, chartM, 0).getDate();
  const chartSales = salesForMonthKey(sales, chartKey);
  const chartCashIn = cashIngresosForMonthKey(getCash(), chartKey);
  const totalVentasChart = sumTot(chartSales);
  const totalCajaInChart = chartCashIn.reduce((a, c) => a + numeric(c.amount, 0), 0);

  const byDay = {};
  for (let day = 1; day <= dim; day++) {
    byDay[day] = 0;
  }
  chartSales.forEach((s) => {
    const day = Number(String(s.date).slice(8, 10));
    if (day >= 1 && day <= dim) {
      byDay[day] = (byDay[day] || 0) + numeric(s.saleTotal, 0);
    }
  });
  chartCashIn.forEach((c) => {
    const day = Number(String(c.date).slice(8, 10));
    if (day >= 1 && day <= dim) {
      byDay[day] = (byDay[day] || 0) + numeric(c.amount, 0);
    }
  });
  const maxDailyTotal = Math.max(...Object.values(byDay), 1);

  const chartEl = document.getElementById("stats-daily-chart");
  if (chartEl) {
    chartEl.innerHTML = "";
    for (let day = 1; day <= dim; day++) {
      const v = byDay[day] || 0;
      const h = Math.round((v / maxDailyTotal) * 140);
      const showLab = dim <= 16 || day === 1 || day === dim || day % 7 === 0;
      const tip = `Día ${day}: entraron ${currency(v)} (ventas + ingresos de caja)`;
      const col = document.createElement("div");
      col.className = "stats-day-col";
      col.title = tip;
      col.style.cursor = "help";
      col.setAttribute("aria-label", tip);
      const bar = document.createElement("div");
      bar.className = "stats-day-bar";
      bar.style.height = `${Math.max(h, 2)}px`;
      bar.title = tip;
      const lab = document.createElement("span");
      lab.className = "stats-day-label";
      lab.textContent = showLab ? String(day) : "·";
      col.appendChild(bar);
      col.appendChild(lab);
      chartEl.appendChild(col);
    }
  }

  const cap = el("stats-chart-caption");
  if (cap) {
    const monthName = new Date(chartY, chartM - 1, 1).toLocaleDateString("es-AR", { month: "long", year: "numeric" });
    const totalEntradas = Object.values(byDay).reduce((a, v) => a + v, 0);
    const peakD = Math.max(...Object.values(byDay), 0);
    cap.textContent = `Total entradas en ${monthName}: ${currency(totalEntradas)} (ventas ${currency(totalVentasChart)} + caja ${currency(totalCajaInChart)}) · mejor día: ${currency(peakD)}`;
  }

  const modelUnits = new Map();
  chartSales.forEach((s) => {
    const key = inventoryModelGroupKey(s.model);
    if (!key) return;
    const units = numeric(s.quantity, 1);
    const row = modelUnits.get(key);
    if (row) {
      row.units += units;
    } else {
      modelUnits.set(key, {
        units,
        display: String(s.model || "").trim() || "Sin modelo",
      });
    }
  });
  const top = [...modelUnits.values()]
    .map((row) => [row.display, row.units])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxU = Math.max(...top.map((x) => x[1]), 1);
  const totalUnitsMonth = chartSales.reduce((a, s) => a + numeric(s.quantity, 1), 0);

  const topEl = document.getElementById("stats-top-models");
  if (topEl) {
    if (top.length === 0) {
      topEl.innerHTML = '<p class="muted">No hay ventas en este mes.</p>';
    } else {
      topEl.innerHTML = top
        .map(([name, units]) => {
          const pct = totalUnitsMonth > 0 ? ((units / totalUnitsMonth) * 100).toFixed(0) : "0";
          return `
        <div class="stats-top-row">
          <div>
            <div class="stats-top-name">${escapeHtml(name)}</div>
            <div class="stats-top-meta">${units} u. · ${pct}% del mes</div>
          </div>
          <div class="stats-top-track">
            <div class="stats-top-fill" style="width:${(units / maxU) * 100}%"></div>
          </div>
        </div>`;
        })
        .join("");
    }
  }

  renderResumenBestSellers();
}

/** Ranking de vendedores en el mes del selector Período (por ganancia de líneas con vendedor asignado). */
function renderResumenBestSellers() {
  const tbody = document.getElementById("resumen-best-sellers-body");
  if (!tbody) return;
  const monthKey = getDashboardMonthKey();
  const monthSales = salesForMonthKey(getSales(), monthKey).filter((s) => {
    const sid = s.sellerId ?? s.seller_id;
    return sid != null && String(sid).trim() !== "";
  });
  const byId = new Map();
  for (const s of monthSales) {
    const sid = String(s.sellerId ?? s.seller_id);
    const row = byId.get(sid) || { count: 0, saleSum: 0, profitSum: 0, commSum: 0 };
    row.count += 1;
    row.saleSum += numeric(s.saleTotal, 0);
    row.profitSum += saleAdjustedProfit(s);
    row.commSum += computeSaleCommission(sid, numeric(s.saleTotal, 0)).commissionAmount;
    byId.set(sid, row);
  }
  const ranked = [...byId.entries()]
    .map(([id, data]) => ({
      id,
      name: getSellerNameById(id) || "Vendedor",
      ...data,
    }))
    .sort((a, b) => b.profitSum - a.profitSum || b.saleSum - a.saleSum);
  const top = ranked.slice(0, 15);
  tbody.innerHTML = "";
  if (top.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted">No hay ventas con vendedor asignado en <strong>${escapeHtml(
      monthKeyToLabel(monthKey)
    )}</strong>. Asigná vendedor al cargar ventas o revisá <strong>Configuraciones → Vendedores</strong>.</td>`;
    tbody.appendChild(tr);
    return;
  }
  top.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.count}</td>
      <td>${currency(r.saleSum)}</td>
      <td>${currency(r.profitSum)}</td>
      <td>${currency(r.commSum)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderReceivables() {
  const body = document.getElementById("receivables-body");
  if (!body) return;
  const vf = readViewFilters("receivables");
  let list = sortedReceivablesList();
  list = filterRowsByActiveMonth(list, "receivables", (r) => r.dueDate || r.createdAt);
  const q = (document.getElementById("receivables-filter-q")?.value || vf.q || "").trim();
  const kindF = document.getElementById("receivables-filter-kind")?.value || vf.kind || "";
  if (kindF) list = list.filter((r) => r.kind === kindF);
  if (q) {
    list = list.filter((r) => textIncludesQuery([r.clientName, r.concept, r.notes].filter(Boolean).join(" "), q));
  }
  body.innerHTML = "";
  if (list.length === 0) {
    renderViewFilterEmptyRow(body, 7, "receivables", "pendientes por cobrar");
    return;
  }
  list.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.recvId = String(r.id);
    const today = new Date().toISOString().slice(0, 10);
    const isOverdue = r.dueDate && r.dueDate < today && numeric(r.amountPending, 0) > 0;
    if (isOverdue) tr.classList.add("alert-row--overdue");
    if (pendingAlertNav?.highlightRecvId && String(r.id) === String(pendingAlertNav.highlightRecvId)) {
      tr.classList.add("alert-row--match");
    }
    const kindLab = RECEIVABLE_KIND_LABEL[r.kind] || r.kind;
    const due = r.dueDate || "—";
    const notes = (r.notes || "").trim();
    tr.innerHTML = `
      <td>${escapeHtml(r.clientName)}</td>
      <td>${escapeHtml(r.concept)}</td>
      <td>${escapeHtml(kindLab)}</td>
      <td>${escapeHtml(due)}</td>
      <td>${currency(numeric(r.amountPending, 0))}</td>
      <td class="muted">${escapeHtml(notes.length > 100 ? `${notes.slice(0, 97)}…` : notes) || "—"}</td>
      <td>
        <button type="button" class="secondary recv-edit-btn" data-id="${escapeHtml(String(r.id))}">Editar</button>
        <button type="button" class="secondary recv-pay-btn" data-id="${escapeHtml(String(r.id))}">Cobrar</button>
        <button type="button" class="danger recv-del-btn" data-id="${escapeHtml(String(r.id))}">Eliminar</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

async function linkPipelineLeadsAfterSale(phoneRaw, saleId, igRaw) {
  if (!saleId) return;
  const digits = normalizePhoneDigits(phoneRaw);
  const igNorm = normalizeIgHandle(igRaw);
  if (!digits && !igNorm) return;
  const leads = getPipelineLeads().filter((l) => {
    if (l.convertedSaleId) return false;
    if (digits && normalizePhoneDigits(l.phone) === digits) return true;
    if (igNorm && normalizeIgHandle(l.igHandle) === igNorm) return true;
    return false;
  });
  if (leads.length === 0) return;
  if (useCloud) {
    try {
      const userId = await getUserId();
      const now = new Date().toISOString();
      for (const lead of leads) {
        const { error } = await supabaseClient
          .from("pipeline_leads")
          .update({
            converted_sale_id: saleId,
            stage: "venta",
            updated_at: now,
          })
          .eq("id", lead.id)
          .eq("user_id", userId);
        if (error) throw error;
      }
    } catch (e) {
      console.warn("No se pudo vincular pipeline con la venta:", e);
    }
  } else {
    const list = readList(KEYS.pipelineLeads);
    let changed = false;
    for (const lead of leads) {
      const idx = list.findIndex((x) => String(x.id) === String(lead.id));
      if (idx >= 0) {
        list[idx].convertedSaleId = saleId;
        list[idx].stage = "venta";
        list[idx].updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) writeList(KEYS.pipelineLeads, list);
  }
}

function createPipelineCard(lead) {
  const card = document.createElement("article");
  card.className = "pipeline-card";
  card.draggable = true;
  card.dataset.pipelineId = String(lead.id);

  const notes = (lead.notes || "").trim();
  const notesShort = notes.length > 100 ? `${notes.slice(0, 97)}…` : notes;
  const srcLab = PIPELINE_SOURCE_LABELS[lead.source] || lead.source;
  const phone = lead.phone || "—";
  const ventaOk = lead.convertedSaleId
    ? `<span class="pipeline-card__sale-ok" title="Venta vinculada en CRM">Venta ✓</span>`
    : `<span class="muted" style="font-size:11px">—</span>`;
  const mcLine = lead.manychatSubscriberId
    ? `<div class="pipeline-card__meta muted"><code class="pipeline-sale-link">${escapeHtml(
        lead.manychatSubscriberId.length > 24
          ? `${lead.manychatSubscriberId.slice(0, 22)}…`
          : lead.manychatSubscriberId
      )}</code></div>`
    : "";
  const manychatBtn = lead.manychatSubscriberId
    ? `<button type="button" class="secondary pipeline-mc-btn" data-manychat-id="${escapeHtml(
        String(lead.manychatSubscriberId)
      )}" title="Abrir el chat en ManyChat (config: APP_MANYCHAT_FB_PREFIX en config.js)">Chat MC</button>`
    : '<button type="button" class="secondary" disabled title="Sin ID de ManyChat">Chat MC</button>';

  card.innerHTML = `
    <h3 class="pipeline-card__title">${escapeHtml(lead.name || "Sin nombre")}</h3>
    <div class="pipeline-card__meta">${escapeHtml(phone)}</div>
    ${lead.email ? `<div class="pipeline-card__meta">${escapeHtml(lead.email)}</div>` : ""}
    ${lead.igHandle ? `<div class="pipeline-card__meta">${escapeHtml(lead.igHandle)}</div>` : ""}
    ${mcLine}
    <span class="pipeline-card__badge">${escapeHtml(srcLab)}</span>
    ${notesShort ? `<div class="pipeline-card__notes">${escapeHtml(notesShort)}</div>` : ""}
    <div class="pipeline-card__foot">
      ${ventaOk}
      ${manychatBtn}
      <button type="button" class="secondary pipeline-edit-btn" data-pipeline-id="${escapeHtml(String(lead.id))}">Editar</button>
      <button type="button" class="secondary pipeline-del-btn" data-pipeline-id="${escapeHtml(String(lead.id))}">Eliminar</button>
    </div>
  `;
  return card;
}

/** Segmento de cuenta en la URL de ManyChat, ej. fb1234567890123 (copiá de app.manychat.com/ESTO/...). */
function getManyChatFbPrefix() {
  const raw = String(window.APP_MANYCHAT_FB_PREFIX || "").trim();
  if (!raw) return "";
  let s = raw.replace(/^https?:\/\/app\.manychat\.com\/?/i, "").replace(/^\/+|\/+$/g, "");
  const first = s.split("/").filter(Boolean)[0] || "";
  return first.trim();
}

/**
 * Abre Live Chat en ManyChat para ese suscriptor.
 * Formato oficial: https://app.manychat.com/fb{account_id}/chat/{user_id}
 * @see https://community.manychat.com (Fabio Gaulke — estructura del link)
 */
function openManyChatLead(manychatSubscriberId) {
  const id = String(manychatSubscriberId || "").trim();
  if (!id) {
    alert("Este lead no tiene ID de ManyChat.");
    return;
  }
  const prefix = getManyChatFbPrefix();
  if (!prefix) {
    alert(
      "Para abrir el chat directo en ManyChat, agregá en CRM/config.js:\n\n" +
        'window.APP_MANYCHAT_FB_PREFIX = "fbTU_NUMERO";\n\n' +
        "Abrí ManyChat en el navegador: en la barra de direcciones verás app.manychat.com/fb123.../… Copiá solo la parte fb123… (antes del siguiente /) y pegala ahí."
    );
    return;
  }
  const url = `https://app.manychat.com/${encodeURIComponent(prefix)}/chat/${encodeURIComponent(id)}`;
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    alert("No se pudo abrir ManyChat. Revisá si el navegador bloqueó la ventana emergente.");
  }
}

async function applyPipelineStageChange(id, newStage) {
  const lead = getPipelineLeads().find((l) => String(l.id) === String(id));
  if (!lead) return;
  if (lead.stage === newStage) return;
  if (useCloud) {
    try {
      const userId = await getUserId();
      const { error } = await supabaseClient
        .from("pipeline_leads")
        .update({
          stage: newStage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throw error;
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al mover la tarjeta.");
      return;
    }
  } else {
    const list = readList(KEYS.pipelineLeads);
    const idx = list.findIndex((x) => String(x.id) === String(id));
    if (idx < 0) return;
    list[idx].stage = newStage;
    list[idx].updatedAt = new Date().toISOString();
    writeList(KEYS.pipelineLeads, list);
  }
  await afterDataChange();
}

function renderPipeline() {
  const board = pipelineBoard;
  if (!board) return;
  const vf = readViewFilters("pipeline");
  const fu = document.getElementById("pipeline-filter-source")?.value || vf.source || "";
  const q = (document.getElementById("pipeline-filter-q")?.value || vf.q || "").trim();
  let list = getPipelineLeads()
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  list = filterRowsByActiveMonth(list, "pipeline", (l) => l.createdAt);
  if (fu) list = list.filter((l) => l.source === fu);
  if (q) {
    list = list.filter((l) =>
      textIncludesQuery(
        [l.name, l.phone, l.email, l.igHandle, l.notes, l.manychatSubscriberId].filter(Boolean).join(" "),
        q
      )
    );
  }

  board.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "pipeline-board-empty muted";
    const mk = monthKeyToLabel(getDashboardMonthKey());
    empty.textContent = viewLimitsToActiveMonth("pipeline")
      ? `No hay leads en ${mk} con estos filtros. Probá «Ver todos los meses» o cambiá el período.`
      : fu
        ? "No hay leads con este origen. Elegí «Todos» o probá otro filtro."
        : "Todavía no hay leads. Se cargarán con ManyChat / webhooks, o tocá «+ Lead manual».";
    board.appendChild(empty);
  }

  const byStage = {};
  PIPELINE_KANBAN_STAGES.forEach((k) => {
    byStage[k] = [];
  });
  list.forEach((lead) => {
    let s = lead.stage;
    if (!PIPELINE_STAGE_LABELS[s] || !PIPELINE_KANBAN_STAGES.includes(s)) s = "nuevo";
    byStage[s].push(lead);
  });

  const colsWrap = document.createElement("div");
  colsWrap.className = "pipeline-board__columns";

  for (const stageKey of PIPELINE_KANBAN_STAGES) {
    const leads = byStage[stageKey] || [];
    const col = document.createElement("div");
    col.className = "pipeline-column";
    col.dataset.stage = stageKey;

    const head = document.createElement("div");
    head.className = "pipeline-column__head";
    head.innerHTML = `<span class="pipeline-column__title">${escapeHtml(
      PIPELINE_STAGE_LABELS[stageKey]
    )}</span><span class="pipeline-column__count">${leads.length}</span>`;

    const drop = document.createElement("div");
    drop.className = "pipeline-column__drop";
    drop.dataset.stage = stageKey;

    leads.forEach((lead) => {
      drop.appendChild(createPipelineCard(lead));
    });

    col.appendChild(head);
    col.appendChild(drop);
    colsWrap.appendChild(col);
  }

  board.appendChild(colsWrap);
}

function setupPipelineBoardInteractions() {
  if (!pipelineBoard || pipelineBoard.dataset.pipelineSetup === "1") return;
  pipelineBoard.dataset.pipelineSetup = "1";

  pipelineBoard.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".pipeline-card");
    if (!card) return;
    e.dataTransfer.setData("text/plain", card.dataset.pipelineId);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("pipeline-card--dragging");
  });

  pipelineBoard.addEventListener("dragend", () => {
    pipelineBoard.querySelectorAll(".pipeline-card--dragging").forEach((c) => {
      c.classList.remove("pipeline-card--dragging");
    });
    pipelineBoard.querySelectorAll(".pipeline-column__drop--over").forEach((d) => {
      d.classList.remove("pipeline-column__drop--over");
    });
  });

  pipelineBoard.addEventListener("dragover", (e) => {
    const drop = e.target.closest(".pipeline-column__drop");
    if (!drop) return;
    e.preventDefault();
    const cols = drop.closest(".pipeline-board__columns");
    if (cols) {
      cols.querySelectorAll(".pipeline-column__drop--over").forEach((d) => {
        if (d !== drop) d.classList.remove("pipeline-column__drop--over");
      });
    }
    drop.classList.add("pipeline-column__drop--over");
  });

  pipelineBoard.addEventListener("drop", async (e) => {
    const drop = e.target.closest(".pipeline-column__drop");
    if (!drop) return;
    e.preventDefault();
    drop.classList.remove("pipeline-column__drop--over");
    const id = e.dataTransfer.getData("text/plain");
    const newStage = drop.dataset.stage;
    if (!id || !newStage) return;
    await applyPipelineStageChange(id, newStage);
  });

  pipelineBoard.addEventListener("click", async (e) => {
    const manychatBtn = e.target.closest(".pipeline-mc-btn");
    if (manychatBtn) {
      e.preventDefault();
      const mcId = manychatBtn.dataset.manychatId || "";
      openManyChatLead(mcId);
      return;
    }
    const editBtn = e.target.closest(".pipeline-edit-btn");
    if (editBtn) {
      e.preventDefault();
      const id = editBtn.dataset.pipelineId;
      if (id) openPipelineModalForEdit(id);
      return;
    }
    const btn = e.target.closest(".pipeline-del-btn");
    if (!btn) return;
    const id = btn.dataset.pipelineId;
    if (!id) return;
    if (!confirm("¿Eliminar este lead?")) return;
    try {
      if (useCloud) {
        const userId = await getUserId();
        const { error } = await supabaseClient.from("pipeline_leads").delete().eq("id", id).eq("user_id", userId);
        if (error) throw error;
      } else {
        const list = readList(KEYS.pipelineLeads).filter((x) => String(x.id) !== String(id));
        writeList(KEYS.pipelineLeads, list);
      }
      await afterDataChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al eliminar.");
    }
  });
}

function clearPipelineEdit() {
  editingPipelineId = null;
  if (pipelineModalTitleEl) pipelineModalTitleEl.textContent = "Agregar lead manual";
  const psb = document.querySelector("#pipeline-lead-form button[type='submit']");
  if (psb) psb.textContent = "Guardar lead";
}

function openPipelineModal() {
  if (!pipelineModal) return;
  if (pipelineLeadForm) pipelineLeadForm.reset();
  const ps = document.getElementById("pipeline-stage");
  const psrc = document.getElementById("pipeline-source");
  if (ps) ps.value = "nuevo";
  if (psrc) psrc.value = "manual";
  clearPipelineEdit();
  pipelineModal.hidden = false;
  pipelineModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
  const n = document.getElementById("pipeline-name");
  requestAnimationFrame(() => n?.focus());
}

function openPipelineModalForEdit(leadId) {
  const lead = getPipelineLeads().find((l) => String(l.id) === String(leadId));
  if (!lead || !pipelineModal) return;
  editingPipelineId = lead.id;
  if (pipelineModalTitleEl) pipelineModalTitleEl.textContent = "Editar lead";
  const psb = document.querySelector("#pipeline-lead-form button[type='submit']");
  if (psb) psb.textContent = "Guardar cambios";
  const n = document.getElementById("pipeline-name");
  const ph = document.getElementById("pipeline-phone");
  const em = document.getElementById("pipeline-email");
  const ig = document.getElementById("pipeline-ig");
  const st = document.getElementById("pipeline-stage");
  const src = document.getElementById("pipeline-source");
  const mc = document.getElementById("pipeline-manychat-id");
  const nt = document.getElementById("pipeline-notes");
  if (n) n.value = lead.name || "";
  if (ph) ph.value = lead.phone || "";
  if (em) em.value = lead.email || "";
  if (ig) ig.value = lead.igHandle || "";
  if (st) st.value = lead.stage || "nuevo";
  if (src) src.value = lead.source || "manual";
  if (mc) mc.value = lead.manychatSubscriberId || "";
  if (nt) nt.value = lead.notes || "";
  pipelineModal.hidden = false;
  pipelineModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
  requestAnimationFrame(() => n?.focus());
}

function closePipelineModal() {
  if (!pipelineModal) return;
  pipelineModal.hidden = true;
  pipelineModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sale-modal-open");
  clearPipelineEdit();
  pipelineLeadForm?.reset();
}

function renderAll() {
  const dm = document.getElementById("dashboard-month");
  if (dm && dm.options.length === 0) {
    populateDashboardMonthSelect();
  }
  updatePeriodBarNote();
  bindViewFilterControls();
  renderSales();
  renderSellersTable();
  renderSellerStats();
  refreshSaleSellerSelect();
  renderWarranties();
  renderCash();
  refreshInvoiceSaleOptions();
  renderInvoices();
  renderInventory();
  renderTechService();
  refreshSaleInventoryPickList();
  renderDashboard();
  renderReceivables();
  renderPipeline();
  renderStatsVisual();
  renderSectionKpis();
  renderCreativos();
  refreshSaleClientSelect();
  renderSaleCart();
  window.__businessExtras?.renderResumenAlerts?.();
  window.__businessExtras?.renderWeeklyCashClose?.();
}

async function afterDataChange() {
  if (useCloud) {
    await refreshCloud();
    mirrorCloudCachesToLocal();
  }
  renderAll();
}

if (salePickInventory) {
  salePickInventory.addEventListener("change", () => {
    const id = salePickInventory.value;
    if (!id) return;
    const inv = getInventory().find((i) => String(i.id) === id);
    if (!inv) return;
    saleModel.value = inv.model || "";
    saleColor.value = inv.color || "";
    saleStorage.value = inv.storage || "";
    saleBattery.value =
      inv.battery === "" || inv.battery == null ? "" : String(inv.battery);
    if (saleImei) {
      const imei = resolveInventoryImei(inv);
      const serial = resolveInventorySerial(inv);
      saleImei.value = imei || serial;
    }
    salePrice.value = String(numeric(inv.price, 0));
    saleCost.value = String(numeric(inv.cost, 0));
    const q = Number(saleQuantity.value) || 1;
    saleQuantity.value = String(inv.stock > 0 ? Math.min(q, inv.stock) : q);
  });
}

if (saleClientSelect && saleClient) {
  saleClientSelect.addEventListener("change", () => {
    const v = saleClientSelect.value;
    if (v === "__new__") {
      saleClient.value = "";
      if (salePhone) salePhone.value = "";
      if (saleIg) saleIg.value = "";
      saleClient.focus();
      return;
    }
    const opt = saleClientSelect.selectedOptions[0];
    const phone = (opt && opt.dataset && opt.dataset.phone) || "";
    const ig = (opt && opt.dataset && opt.dataset.ig) || "";
    saleClient.value = v;
    if (salePhone) salePhone.value = phone;
    if (saleIg) saleIg.value = ig;
  });

  saleClient.addEventListener("input", () => {
    const t = saleClient.value.trim();
    if (!t) {
      saleClientSelect.value = "__new__";
      return;
    }
    if ([...saleClientSelect.options].some((o) => o.value === t)) {
      saleClientSelect.value = t;
    } else {
      saleClientSelect.value = "__new__";
    }
  });
}

if (saleTradeInValue) {
  saleTradeInValue.addEventListener("input", () => updateSaleCheckoutSummary());
}

if (saleAddCartBtn) {
  saleAddCartBtn.addEventListener("click", () => {
    if (addFilledSaleFormToCart() && saleImei) saleImei.value = "";
  });
}

if (saleCartBody) {
  saleCartBody.addEventListener("click", (event) => {
    const t = event.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains("sale-cart-remove")) return;
    const id = t.dataset.lineId;
    if (!id) return;
    saleCart = saleCart.filter((line) => line.id !== id);
    renderSaleCart();
  });
}

if (saleCartClearBtn) {
  saleCartClearBtn.addEventListener("click", () => {
    if (saleCart.length === 0) return;
    const ok = confirm("¿Vaciar todo el carrito?");
    if (!ok) return;
    saleCart = [];
    renderSaleCart();
  });
}

saleForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!syncSaleFormIntoCartIfNeeded()) {
    return;
  }
  if (saleCart.length === 0) {
    alert("Agregá al menos un producto al carrito.");
    return;
  }

  if (!saleDate.value || !saleClient.value.trim()) {
    alert("Completá la fecha y el nombre del cliente.");
    return;
  }

  const lines = saleCart.slice();
  const grossWeights = lines.map((line) => numeric(line.quantity, 0) * numeric(line.unitSale, 0));
  const grossCart = grossWeights.reduce((a, b) => a + b, 0);

  const tradeInDescription = saleTradeInDesc ? saleTradeInDesc.value.trim() : "";
  const tradeInValue = saleTradeInValue ? numeric(saleTradeInValue.value, 0) : 0;
  const tiModel = saleTradeInModel?.value?.trim() ?? "";
  const tiColor = saleTradeInColor?.value?.trim() ?? "";
  const tiStorage = saleTradeInStorage?.value?.trim() ?? "";
  const tiBatteryRaw =
    saleTradeInBattery?.value === "" || saleTradeInBattery?.value == null
      ? ""
      : String(saleTradeInBattery.value);
  const anyTiPart =
    Boolean(tiModel || tiColor || tiStorage) ||
    (saleTradeInBattery?.value !== "" && saleTradeInBattery?.value != null);
  const allTiForStock = Boolean(tiModel && tiColor && tiStorage);
  if (anyTiPart && !allTiForStock) {
    alert(
      "Para sumar el canje al inventario completá modelo, color y almacenamiento del equipo en canje (o dejá esos tres vacíos)."
    );
    return;
  }

  const tiListPriceRaw =
    saleTradeInInvPrice?.value === "" || saleTradeInInvPrice?.value == null
      ? NaN
      : Number(saleTradeInInvPrice.value);
  const tiListPrice =
    Number.isFinite(tiListPriceRaw) && tiListPriceRaw >= 0 ? tiListPriceRaw : tradeInValue;
  const tiCost = tradeInValue;

  const netTotal = Math.max(0, grossCart - tradeInValue);
  const saleTotals = splitProportionalUsd(netTotal, grossWeights);
  const tradeInParts = splitProportionalUsd(tradeInValue, grossWeights);

  const paymentCash = salePayCash ? numeric(salePayCash.value, 0) : 0;
  const paymentTransfer = salePayTransfer ? numeric(salePayTransfer.value, 0) : 0;
  const paymentCard = salePayCard ? numeric(salePayCard.value, 0) : 0;
  const paymentOther = salePayOther ? numeric(salePayOther.value, 0) : 0;
  const paymentNotes = salePayment ? salePayment.value.trim() : "";
  const selectedSellerRaw = saleSeller?.value?.trim() || "";
  const selectedSellerId = selectedSellerRaw || null;

  const payCashParts = splitProportionalUsd(paymentCash, saleTotals);
  const payTransferParts = splitProportionalUsd(paymentTransfer, saleTotals);
  const payCardParts = splitProportionalUsd(paymentCard, saleTotals);
  const payOtherParts = splitProportionalUsd(paymentOther, saleTotals);

  if (window.__businessExtras?.validateSaleBeforeSave) {
    const ok = window.__businessExtras.validateSaleBeforeSave({
      lines,
      saleTotals,
      tradeInValue,
      paymentCash,
      paymentTransfer,
      paymentCard,
      paymentOther,
      editingSaleId,
    });
    if (!ok) return;
  }

  const clientPhoneForPipeline = salePhone ? salePhone.value.trim() : "";
  const clientIgForPipeline = saleIg ? saleIg.value.trim() : "";
  let firstSaleIdForPipeline = null;

  function getMatchForSavedLine(line, inventory) {
    if (line.matchId) {
      const byId = inventory.find((i) => String(i.id) === String(line.matchId));
      if (
        byId &&
        getInventoryKey(byId.model, byId.color, byId.storage, byId.battery) ===
          getInventoryKey(line.model, line.color, line.storage, line.battery)
      ) {
        return byId;
      }
    }
    return findInventoryRowByKeys(inventory, line.model, line.color, line.storage, line.battery);
  }

  if (editingSaleId) {
    if (lines.length !== 1) {
      alert("Al editar debe haber un solo producto en el carrito (correspondiente a esa fila de venta).");
      return;
    }
    const saleBeforeEdit = getSales().find((s) => String(s.id) === String(editingSaleId));
    const prevDevId = resolveSaleDeviceIdentity(saleBeforeEdit || {});
    const i = 0;
    const line = lines[0];
    const saleTotal = saleTotals[i] ?? 0;
    const costTotal = numeric(line.quantity, 0) * numeric(line.unitCost, 0);
    const profit = saleTotal - costTotal;
    const comm = computeSaleCommission(selectedSellerId, saleTotal);

    const saleUpdatePayload = {
      sale_date: saleDate.value,
      client_name: saleClient.value.trim(),
      phone: salePhone ? salePhone.value.trim() : "",
      ig_handle: saleIg ? saleIg.value.trim() : "",
      model: line.model,
      color: line.color,
      storage: line.storage,
      battery: line.battery || "",
      imei: formatSaleImeiForStorage(line),
      quantity: line.quantity,
      unit_sale: line.unitSale,
      unit_cost: line.unitCost,
      payment: paymentNotes,
      trade_in_description: tradeInDescription,
      trade_in_value: tradeInParts[i] ?? 0,
      trade_in_inv_model: allTiForStock ? tiModel : "",
      trade_in_inv_color: allTiForStock ? tiColor : "",
      trade_in_inv_storage: allTiForStock ? tiStorage : "",
      trade_in_inv_battery: allTiForStock ? tiBatteryRaw : "",
      payment_cash: payCashParts[i] ?? 0,
      payment_transfer: payTransferParts[i] ?? 0,
      payment_card: payCardParts[i] ?? 0,
      payment_other: payOtherParts[i] ?? 0,
      sale_total: saleTotal,
      cost_total: costTotal,
      profit,
      deduct_from_inventory: line.deductInventory,
      seller_id: comm.sellerId,
      commission_pct_applied: comm.commissionPctApplied,
      commission_amount: comm.commissionAmount,
    };

    if (useCloud) {
      try {
        const userId = await getUserId();
        let { error: saleErr } = await supabaseClient
          .from("sales")
          .update(saleUpdatePayload)
          .eq("id", editingSaleId)
          .eq("user_id", userId);
        if (
          saleErr &&
          /schema cache|could not find.*ig_handle.*sales/i.test(saleErr.message || "")
        ) {
          const { ig_handle: _omitIg, ...saleUpdateNoIg } = saleUpdatePayload;
          ({ error: saleErr } = await supabaseClient
            .from("sales")
            .update(saleUpdateNoIg)
            .eq("id", editingSaleId)
            .eq("user_id", userId));
        }
        if (saleErr) throw saleErr;
        patchCachedSaleAfterEdit(editingSaleId, {
          date: saleDate.value,
          client: saleClient.value.trim(),
          phone: salePhone ? salePhone.value.trim() : "",
          igHandle: saleIg ? saleIg.value.trim() : "",
          model: line.model,
          color: line.color,
          storage: line.storage,
          battery: line.battery,
          imei: formatSaleImeiForStorage(line),
          quantity: line.quantity,
          unitSale: line.unitSale,
          unitCost: line.unitCost,
          payment: paymentNotes,
          tradeInDescription,
          tradeInValue: tradeInParts[i] ?? 0,
          saleTotal,
          costTotal,
          profit,
          deductFromInventory: line.deductInventory,
          sellerId: comm.sellerId,
          commissionPctApplied: comm.commissionPctApplied,
          commissionAmount: comm.commissionAmount,
        });
        await syncCommissionCashFromSale(
          userId,
          editingSaleId,
          saleDate.value,
          saleClient.value.trim(),
          comm.commissionAmount,
          comm.sellerId
        );
      } catch (e) {
        alert(formatSaleSaveError(e));
        return;
      }
    } else {
      const sales = readList(KEYS.sales);
      const idx = sales.findIndex((s) => String(s.id) === String(editingSaleId));
      if (idx >= 0) {
        const prev = sales[idx];
        sales[idx] = {
          ...prev,
          date: saleDate.value,
          client: saleClient.value.trim(),
          phone: salePhone ? salePhone.value.trim() : "",
          igHandle: saleIg ? saleIg.value.trim() : "",
          model: line.model,
          color: line.color,
          storage: line.storage,
          battery: line.battery,
          imei: formatSaleImeiForStorage(line),
          quantity: line.quantity,
          unitSale: line.unitSale,
          unitCost: line.unitCost,
          payment: paymentNotes,
          tradeInDescription,
          tradeInValue: tradeInParts[i] ?? 0,
          tradeInInvModel: allTiForStock ? tiModel : "",
          tradeInInvColor: allTiForStock ? tiColor : "",
          tradeInInvStorage: allTiForStock ? tiStorage : "",
          tradeInInvBattery: allTiForStock ? tiBatteryRaw : "",
          paymentCash: payCashParts[i] ?? 0,
          paymentTransfer: payTransferParts[i] ?? 0,
          paymentCard: payCardParts[i] ?? 0,
          paymentOther: payOtherParts[i] ?? 0,
          saleTotal,
          costTotal,
          profit,
          deductFromInventory: line.deductInventory,
          sellerId: comm.sellerId,
          commissionPctApplied: comm.commissionPctApplied,
          commissionAmount: comm.commissionAmount,
        };
        writeList(KEYS.sales, sales);
      }
      patchCachedSaleAfterEdit(editingSaleId, {
        date: saleDate.value,
        client: saleClient.value.trim(),
        phone: salePhone ? salePhone.value.trim() : "",
        igHandle: saleIg ? saleIg.value.trim() : "",
        model: line.model,
        color: line.color,
        storage: line.storage,
        battery: line.battery,
        imei: formatSaleImeiForStorage(line),
        quantity: line.quantity,
        unitSale: line.unitSale,
        unitCost: line.unitCost,
        payment: paymentNotes,
        tradeInDescription,
        tradeInValue: tradeInParts[i] ?? 0,
        saleTotal,
        costTotal,
        profit,
        deductFromInventory: line.deductInventory,
        sellerId: comm.sellerId,
        commissionPctApplied: comm.commissionPctApplied,
        commissionAmount: comm.commissionAmount,
      });
      await syncCommissionCashFromSale(
        null,
        editingSaleId,
        saleDate.value,
        saleClient.value.trim(),
        comm.commissionAmount,
        comm.sellerId
      );
    }

    const updatedSale = getSales().find((s) => String(s.id) === String(editingSaleId));
    if (updatedSale) void backfillDeviceHistoryAfterSaleIdentityUpdate(updatedSale, prevDevId);

    resetSaleModalFields();
    hideSaleModal();
    await afterDataChange();
    return;
  }

  if (useCloud) {
    try {
      const userId = await getUserId();
      for (let i = 0; i < lines.length; i++) {
        await refreshCloud();
        const inventory = getInventory();
        const line = lines[i];
        const match = getMatchForSavedLine(line, inventory);

        if (line.deductInventory) {
          if (!match || match.stock < line.quantity) {
            alert(
              `No hay stock suficiente para ${line.model} (${line.color}). Actualizá el carrito o el inventario y probá de nuevo.`
            );
            return;
          }
          await cloudApplySoldInventoryDeduction(userId, match, line.quantity);
        }

        const saleTotal = saleTotals[i] ?? 0;
        const costTotal = numeric(line.quantity, 0) * numeric(line.unitCost, 0);
        const profit = saleTotal - costTotal;
        const comm = computeSaleCommission(selectedSellerId, saleTotal);

        const salePayload = {
          user_id: userId,
          sale_date: saleDate.value,
          client_name: saleClient.value.trim(),
          phone: salePhone.value.trim(),
          ig_handle: saleIg ? saleIg.value.trim() : "",
          model: line.model,
          color: line.color,
          storage: line.storage,
          battery: line.battery || "",
          imei: formatSaleImeiForStorage(line),
          quantity: line.quantity,
          unit_sale: line.unitSale,
          unit_cost: line.unitCost,
          payment: paymentNotes,
          trade_in_description: i === 0 ? tradeInDescription : "",
          trade_in_value: tradeInParts[i] ?? 0,
          trade_in_inv_model: i === 0 && allTiForStock ? tiModel : "",
          trade_in_inv_color: i === 0 && allTiForStock ? tiColor : "",
          trade_in_inv_storage: i === 0 && allTiForStock ? tiStorage : "",
          trade_in_inv_battery: i === 0 && allTiForStock ? tiBatteryRaw : "",
          payment_cash: payCashParts[i] ?? 0,
          payment_transfer: payTransferParts[i] ?? 0,
          payment_card: payCardParts[i] ?? 0,
          payment_other: payOtherParts[i] ?? 0,
          sale_total: saleTotal,
          cost_total: costTotal,
          profit,
          deduct_from_inventory: line.deductInventory,
          seller_id: comm.sellerId,
          commission_pct_applied: comm.commissionPctApplied,
          commission_amount: comm.commissionAmount,
        };
        let { data: insRow, error: saleErr } = await supabaseClient
          .from("sales")
          .insert(salePayload)
          .select("id")
          .single();
        if (
          saleErr &&
          /schema cache|could not find.*ig_handle.*sales/i.test(saleErr.message || "")
        ) {
          const { ig_handle: _omitIg, ...salePayloadNoIg } = salePayload;
          ({ data: insRow, error: saleErr } = await supabaseClient
            .from("sales")
            .insert(salePayloadNoIg)
            .select("id")
            .single());
        }
        if (saleErr) throw saleErr;
        if (insRow?.id) {
          await syncCommissionCashFromSale(
            userId,
            insRow.id,
            saleDate.value,
            saleClient.value.trim(),
            comm.commissionAmount,
            comm.sellerId
          );
          const devId = resolveLineDeviceIdentity(line);
          void logDeviceHistoryEvent({
            eventType: "venta",
            serial: devId.serial,
            imei: devId.imei,
            saleId: insRow.id,
            clientName: saleClient.value.trim(),
            model: line.model,
            color: line.color,
            storage: line.storage,
            battery: line.battery || "",
            detail: line.deductInventory ? "Descontado del inventario" : "Venta sin descuento de stock",
            eventAt: `${saleDate.value}T12:00:00.000Z`,
          });
        }
        if (i === 0 && insRow?.id) firstSaleIdForPipeline = insRow.id;
      }

      if (allTiForStock) {
        await refreshCloud();
        mirrorCloudCachesToLocal();
        await cloudAddTradeInInventoryUnit(userId, tiModel, tiColor, tiStorage, tiBatteryRaw, tiListPrice, tiCost);
      }
    } catch (e) {
      alert(formatSaleSaveError(e));
      return;
    }
  } else {
    const localInv = readList(KEYS.inventory);
    const sales = readList(KEYS.sales);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const match = getMatchForSavedLine(line, localInv);

      if (line.deductInventory) {
        if (!match || match.stock < line.quantity) {
          alert(
            `No hay stock suficiente para ${line.model} (${line.color}). Actualizá el carrito o el inventario y probá de nuevo.`
          );
          return;
        }
        const localMatch = localInv.find((x) => x.id === match.id);
        if (localMatch) {
          localApplySoldInventoryDeduction(localInv, localMatch, line.quantity);
        }
      }

      const saleTotal = saleTotals[i] ?? 0;
      const costTotal = numeric(line.quantity, 0) * numeric(line.unitCost, 0);
      const profit = saleTotal - costTotal;
      const comm = computeSaleCommission(selectedSellerId, saleTotal);

      const newSaleId = crypto.randomUUID();
      if (i === 0) firstSaleIdForPipeline = newSaleId;

      sales.unshift({
        id: newSaleId,
        date: saleDate.value,
        client: saleClient.value.trim(),
        phone: salePhone.value.trim(),
        igHandle: saleIg ? saleIg.value.trim() : "",
        model: line.model,
        color: line.color,
        storage: line.storage,
        battery: line.battery,
        imei: formatSaleImeiForStorage(line),
        quantity: line.quantity,
        unitSale: line.unitSale,
        unitCost: line.unitCost,
        payment: paymentNotes,
        tradeInDescription: i === 0 ? tradeInDescription : "",
        tradeInValue: tradeInParts[i] ?? 0,
        tradeInInvModel: i === 0 && allTiForStock ? tiModel : "",
        tradeInInvColor: i === 0 && allTiForStock ? tiColor : "",
        tradeInInvStorage: i === 0 && allTiForStock ? tiStorage : "",
        tradeInInvBattery: i === 0 && allTiForStock ? tiBatteryRaw : "",
        paymentCash: payCashParts[i] ?? 0,
        paymentTransfer: payTransferParts[i] ?? 0,
        paymentCard: payCardParts[i] ?? 0,
        paymentOther: payOtherParts[i] ?? 0,
        saleTotal,
        costTotal,
        profit,
        deductFromInventory: line.deductInventory,
        sellerId: comm.sellerId,
        commissionPctApplied: comm.commissionPctApplied,
        commissionAmount: comm.commissionAmount,
      });
      await syncCommissionCashFromSale(
        null,
        newSaleId,
        saleDate.value,
        saleClient.value.trim(),
        comm.commissionAmount,
        comm.sellerId
      );
      const devId = resolveLineDeviceIdentity(line);
      void logDeviceHistoryEvent({
        eventType: "venta",
        serial: devId.serial,
        imei: devId.imei,
        saleId: newSaleId,
        clientName: saleClient.value.trim(),
        model: line.model,
        color: line.color,
        storage: line.storage,
        battery: line.battery || "",
        detail: line.deductInventory ? "Descontado del inventario" : "Venta sin descuento de stock",
        eventAt: `${saleDate.value}T12:00:00.000Z`,
      });
    }
    if (allTiForStock) {
      localAddTradeInInventoryUnit(localInv, tiModel, tiColor, tiStorage, tiBatteryRaw, tiListPrice, tiCost);
    }
    writeList(KEYS.inventory, localInv);
    writeList(KEYS.sales, sales);
  }

  if (firstSaleIdForPipeline && (clientPhoneForPipeline || clientIgForPipeline)) {
    await linkPipelineLeadsAfterSale(clientPhoneForPipeline, firstSaleIdForPipeline, clientIgForPipeline);
  }

  saleCart = [];
  saleForm.reset();
  if (salePickInventory) salePickInventory.value = "";
  saleQuantity.value = "1";
  if (saleTradeInValue) saleTradeInValue.value = "0";
  if (salePayCash) salePayCash.value = "0";
  if (salePayTransfer) salePayTransfer.value = "0";
  if (salePayCard) salePayCard.value = "0";
  if (salePayOther) salePayOther.value = "0";
  if (saleClientSelect) saleClientSelect.value = "__new__";
  setTodayDefaults();
  renderSaleCart();
  await afterDataChange();
  hideSaleModal();
});

if (btnOpenSaleModal) {
  btnOpenSaleModal.addEventListener("click", () => openSaleModal());
}

function clientPurchaseRows() {
  const byName = new Map();
  for (const sale of getSales()) {
    const name = String(sale.client || "").trim();
    if (!name) continue;
    const row = byName.get(name) || {
      name,
      phone: "",
      ig: "",
      date: "",
      model: "",
      count: 0,
    };
    row.count += 1;
    const phone = String(sale.phone || "").trim();
    const ig = String(sale.igHandle || "").trim();
    if (phone) row.phone = phone;
    if (ig) row.ig = ig;
    if (!row.date || String(sale.date || "") >= String(row.date)) {
      row.date = sale.date || row.date;
      row.model = sale.model || row.model;
    }
    byName.set(name, row);
  }
  return [...byName.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function renderClientsList() {
  const list = document.getElementById("clients-list");
  const q = (document.getElementById("clients-search")?.value || "").trim().toLowerCase();
  if (!list) return;
  const rows = clientPurchaseRows().filter((row) => {
    if (!q) return true;
    return `${row.name} ${row.phone} ${row.model}`.toLowerCase().includes(q);
  });
  if (!rows.length) {
    list.innerHTML = `<p class="muted">Todavía no hay clientes en las ventas.</p>`;
    return;
  }
  list.innerHTML = rows
    .map((row) => {
      const bits = [row.phone, row.model, row.date].filter(Boolean).join(" · ");
      return `<article class="clients-row">
        <div>
          <strong>${escapeHtml(row.name)}</strong>
          <p class="muted">${escapeHtml(bits)} · ${row.count} compra${row.count === 1 ? "" : "s"}</p>
        </div>
        <button type="button" data-client-name="${escapeHtml(row.name)}">Vender de nuevo</button>
      </article>`;
    })
    .join("");
}

function openClientsModal() {
  const modal = document.getElementById("clients-modal");
  if (!modal) return;
  const search = document.getElementById("clients-search");
  if (search) search.value = "";
  renderClientsList();
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sale-modal-open");
  search?.focus();
}

function hideClientsModal() {
  const modal = document.getElementById("clients-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sale-modal-open");
}

function sellAgainToClient(name) {
  hideClientsModal();
  switchTab("ventas");
  openSaleModal();
  refreshSaleClientSelect();
  if (saleClientSelect && [...saleClientSelect.options].some((opt) => opt.value === name)) {
    saleClientSelect.value = name;
    saleClientSelect.dispatchEvent(new Event("change"));
  } else if (saleClient) {
    saleClient.value = name;
  }
}

document.getElementById("btn-open-clients")?.addEventListener("click", () => openClientsModal());
document.getElementById("clients-modal-close")?.addEventListener("click", () => hideClientsModal());
document.getElementById("clients-modal-done")?.addEventListener("click", () => hideClientsModal());
document.getElementById("clients-modal-backdrop")?.addEventListener("click", () => hideClientsModal());
document.getElementById("clients-search")?.addEventListener("input", () => renderClientsList());
document.getElementById("clients-list")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-client-name]");
  if (!(btn instanceof HTMLElement)) return;
  sellAgainToClient(btn.dataset.clientName || "");
});

if (saleModalClose) {
  saleModalClose.addEventListener("click", () => closeSaleModalInteractive());
}
if (saleModalCancel) {
  saleModalCancel.addEventListener("click", () => closeSaleModalInteractive());
}
if (saleModalBackdrop) {
  saleModalBackdrop.addEventListener("click", () => closeSaleModalInteractive());
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (invUnitModal && !invUnitModal.hidden) {
    hideInvUnitModal();
    return;
  }
  if (deviceHistoryModal && !deviceHistoryModal.hidden) {
    hideDeviceHistoryModal();
    return;
  }
  if (invBulkModal && !invBulkModal.hidden) {
    hideInvBulkModal();
    return;
  }
  if (pipelineModal && !pipelineModal.hidden) {
    closePipelineModal();
    return;
  }
  if (saleModal && !saleModal.hidden) closeSaleModalInteractive();
});

if (invoiceForm) {
  invoiceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const issueDate = invoiceDate?.value || "";
    const taxPct = numeric(invoiceTaxPct?.value, 0);
    const notes = invoiceNotes?.value?.trim() || "";

    if (!issueDate) {
      alert("Completá la fecha de emisión.");
      return;
    }
    if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 100) {
      alert("El impuesto debe estar entre 0 y 100.");
      return;
    }

    if (editingInvoiceId) {
      const inv = getInvoices().find((x) => String(x.id) === String(editingInvoiceId));
      if (!inv || inv.status === "anulado") {
        alert("Comprobante no encontrado o anulado.");
        clearInvoiceEdit();
        return;
      }
      const saleLinked = getSales().find((s) => String(s.id) === String(inv.saleId));
      const subtotal = saleLinked ? numeric(saleLinked.saleTotal, 0) : numeric(inv.subtotal, 0);
      const taxAmount = (subtotal * taxPct) / 100;
      const total = subtotal + taxAmount;
      const clientName = saleLinked?.client || inv.clientName || "";

      if (useCloud) {
        try {
          const userId = await getUserId();
          const { error } = await supabaseClient
            .from("invoices")
            .update({
              issue_date: issueDate,
              sale_date: saleLinked?.date || inv.saleDate || null,
              client_name: clientName,
              subtotal,
              tax_pct: taxPct,
              tax_amount: taxAmount,
              total,
              notes,
            })
            .eq("id", editingInvoiceId)
            .eq("user_id", userId);
          if (error) throw error;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err || "");
          alert(
            /relation|does not exist|schema cache|not find.*invoices/i.test(msg)
              ? `Falta la tabla invoices o permisos en Supabase.\n\n${msg}`
              : msg || "Error al actualizar comprobante."
          );
          return;
        }
      } else {
        const list = getInvoices();
        const ix = list.findIndex((x) => String(x.id) === String(editingInvoiceId));
        if (ix >= 0) {
          list[ix] = {
            ...list[ix],
            issueDate,
            saleDate: saleLinked?.date || list[ix].saleDate,
            clientName,
            subtotal,
            taxPct,
            taxAmount,
            total,
            notes,
          };
          writeList(KEYS.invoices, list);
        }
      }
      clearInvoiceEdit();
      invoiceForm.reset();
      if (invoiceTaxPct) invoiceTaxPct.value = "0";
      setTodayDefaults();
      refreshInvoiceSaleOptions();
      closeCrudModal(invoiceModal);
      await afterDataChange();
      return;
    }

    const saleId = invoiceSaleId?.value || "";
    const typeId = invoiceType?.value || "ticket";
    const sale = getSales().find((s) => String(s.id) === String(saleId));
    if (!saleId || !sale) {
      alert("Elegí una venta para facturar.");
      return;
    }
    const subtotal = numeric(sale.saleTotal, 0);
    const taxAmount = (subtotal * taxPct) / 100;
    const total = subtotal + taxAmount;
    const payload = {
      id: crypto.randomUUID(),
      saleId: sale.id,
      saleDate: sale.date,
      clientName: sale.client,
      invoiceNumber: nextInvoiceNumber(typeId),
      invoiceType: typeId,
      issueDate,
      subtotal,
      taxPct,
      taxAmount,
      total,
      notes,
      status: "emitido",
      createdAt: new Date().toISOString(),
    };
    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient.from("invoices").insert({
          id: payload.id,
          user_id: userId,
          sale_id: payload.saleId,
          sale_date: payload.saleDate || null,
          client_name: payload.clientName || "",
          invoice_number: payload.invoiceNumber,
          invoice_type: payload.invoiceType,
          issue_date: payload.issueDate,
          subtotal: payload.subtotal,
          tax_pct: payload.taxPct,
          tax_amount: payload.taxAmount,
          total: payload.total,
          notes: payload.notes,
          status: payload.status,
        });
        if (error) throw error;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || "");
        alert(
          /relation|does not exist|schema cache|not find.*invoices/i.test(msg)
            ? `Falta la tabla invoices en Supabase. Ejecutá CRM/supabase/migration_invoices.sql\n\n${msg}`
            : msg || "Error al emitir comprobante."
        );
        return;
      }
    } else {
      const list = getInvoices();
      list.unshift(payload);
      writeList(KEYS.invoices, list);
    }
    clearInvoiceEdit();
    invoiceForm.reset();
    if (invoiceTaxPct) invoiceTaxPct.value = "0";
    setTodayDefaults();
    refreshInvoiceSaleOptions();
    closeCrudModal(invoiceModal);
    await afterDataChange();
  });
}

if (btnInvoiceExport) {
  btnInvoiceExport.addEventListener("click", () => downloadInvoicesCsv());
}

if (pipelineLeadForm) {
  pipelineLeadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("pipeline-name")?.value?.trim() || "";
    const phone = document.getElementById("pipeline-phone")?.value?.trim() || "";
    const email = document.getElementById("pipeline-email")?.value?.trim() || "";
    const ig = document.getElementById("pipeline-ig")?.value?.trim() || "";
    const stage = document.getElementById("pipeline-stage")?.value || "nuevo";
    const source = document.getElementById("pipeline-source")?.value || "manual";
    const mcId = document.getElementById("pipeline-manychat-id")?.value?.trim() || "";
    const notes = document.getElementById("pipeline-notes")?.value?.trim() || "";
    if (!name) {
      alert("Completá al menos el nombre del lead.");
      return;
    }
    const now = new Date().toISOString();

    if (editingPipelineId) {
      if (useCloud) {
        try {
          const userId = await getUserId();
          const { error } = await supabaseClient
            .from("pipeline_leads")
            .update({
              stage,
              source,
              manychat_subscriber_id: mcId,
              phone,
              name,
              email,
              ig_handle: ig,
              notes,
              last_manychat_interaction_at: source === "manychat" ? now : null,
              updated_at: now,
            })
            .eq("id", editingPipelineId)
            .eq("user_id", userId);
          if (error) throw error;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/duplicate|unique|pipeline_leads_user_manychat/i.test(msg)) {
            alert("Ya existe otro lead con ese ID de ManyChat.");
          } else {
            alert(msg || "Error al actualizar lead.");
          }
          return;
        }
      } else {
        const list = readList(KEYS.pipelineLeads);
        const idx = list.findIndex((x) => String(x.id) === String(editingPipelineId));
        if (idx >= 0) {
          const prev = list[idx];
          list[idx] = {
            ...prev,
            stage,
            source,
            manychatSubscriberId: mcId,
            phone,
            name,
            email,
            igHandle: ig,
            notes,
            lastManychatAt: source === "manychat" ? now : prev.lastManychatAt,
            updatedAt: now,
          };
          writeList(KEYS.pipelineLeads, list);
        }
      }
      pipelineLeadForm.reset();
      const ps = document.getElementById("pipeline-stage");
      const psrc = document.getElementById("pipeline-source");
      if (ps) ps.value = "nuevo";
      if (psrc) psrc.value = "manual";
      await afterDataChange();
      closePipelineModal();
      return;
    }

    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient.from("pipeline_leads").insert({
          user_id: userId,
          stage,
          source,
          manychat_subscriber_id: mcId,
          phone,
          name,
          email,
          ig_handle: ig,
          metadata: {},
          last_manychat_interaction_at: source === "manychat" ? now : null,
          notes,
          assigned_to: "",
        });
        if (error) throw error;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/duplicate|unique|pipeline_leads_user_manychat/i.test(msg)) {
          alert(
            "Ya existe un lead con ese ID de ManyChat. Editá el existente o usá otro subscriber ID."
          );
        } else {
          alert(msg || "Error al guardar lead.");
        }
        return;
      }
    } else {
      const list = readList(KEYS.pipelineLeads);
      list.unshift({
        id: crypto.randomUUID(),
        stage,
        source,
        manychatSubscriberId: mcId,
        phone,
        name,
        email,
        igHandle: ig,
        metadata: {},
        lastManychatAt: source === "manychat" ? now : null,
        assignedTo: "",
        convertedSaleId: null,
        notes,
        createdAt: now,
        updatedAt: now,
      });
      writeList(KEYS.pipelineLeads, list);
    }
    pipelineLeadForm.reset();
    const ps = document.getElementById("pipeline-stage");
    const psrc = document.getElementById("pipeline-source");
    if (ps) ps.value = "nuevo";
    if (psrc) psrc.value = "manual";
    await afterDataChange();
    closePipelineModal();
  });
}

if (btnOpenPipelineModal) {
  btnOpenPipelineModal.addEventListener("click", () => openPipelineModal());
}
if (pipelineModalClose) {
  pipelineModalClose.addEventListener("click", () => closePipelineModal());
}
if (pipelineModalCancel) {
  pipelineModalCancel.addEventListener("click", () => closePipelineModal());
}
if (pipelineModalBackdrop) {
  pipelineModalBackdrop.addEventListener("click", () => closePipelineModal());
}

function syncBodyModalLock() {
  const anyOpen = document.querySelector(".sale-modal:not([hidden])");
  document.body.classList.toggle("sale-modal-open", Boolean(anyOpen));
}

function openCrudModal(modalEl, focusEl) {
  if (!modalEl) return;
  modalEl.hidden = false;
  modalEl.setAttribute("aria-hidden", "false");
  syncBodyModalLock();
  focusEl?.focus();
}

function closeCrudModal(modalEl) {
  if (!modalEl) return;
  modalEl.hidden = true;
  modalEl.setAttribute("aria-hidden", "true");
  syncBodyModalLock();
}

function wireCrudModal(modalEl, { backdrop, closeEls = [], onClose }) {
  if (!modalEl || modalEl.dataset.wired) return;
  modalEl.dataset.wired = "1";
  const close = () => {
    onClose?.();
    closeCrudModal(modalEl);
  };
  backdrop?.addEventListener("click", close);
  closeEls.forEach((el) => el?.addEventListener("click", close));
}

function resetCashFormDefaults() {
  cashForm?.reset();
  if (cashType) cashType.value = "ingreso";
  setTodayDefaults();
  syncCashRepartoDestUi();
}

function openCashModalForNew() {
  clearCashEdit();
  resetCashFormDefaults();
  if (cashModalTitle) cashModalTitle.textContent = "Nuevo movimiento";
  openCrudModal(cashModal, cashConcept);
}

function openCashModalForEdit() {
  if (cashModalTitle) cashModalTitle.textContent = "Editar movimiento";
  openCrudModal(cashModal, cashConcept);
}

function closeCashModal() {
  clearCashEdit();
  resetCashFormDefaults();
  closeCrudModal(cashModal);
}

function openInvoiceModalForNew() {
  clearInvoiceEdit();
  invoiceForm?.reset();
  if (invoiceTaxPct) invoiceTaxPct.value = "0";
  setTodayDefaults();
  refreshInvoiceSaleOptions();
  if (invoiceModalTitle) invoiceModalTitle.textContent = "Emitir comprobante";
  openCrudModal(invoiceModal, invoiceSaleId);
}

function openInvoiceModalForEdit() {
  if (invoiceModalTitle) invoiceModalTitle.textContent = "Editar comprobante";
  openCrudModal(invoiceModal, invoiceDate);
}

function closeInvoiceModal() {
  clearInvoiceEdit();
  invoiceForm?.reset();
  if (invoiceTaxPct) invoiceTaxPct.value = "0";
  setTodayDefaults();
  refreshInvoiceSaleOptions();
  closeCrudModal(invoiceModal);
}

function openReceivableModalForNew() {
  clearRecvEdit();
  receivableForm?.reset();
  if (receivableModalTitle) receivableModalTitle.textContent = "Nuevo pendiente";
  openCrudModal(receivableModal, document.getElementById("recv-client"));
}

function openReceivableModalForEdit() {
  if (receivableModalTitle) receivableModalTitle.textContent = "Editar pendiente";
  openCrudModal(receivableModal, document.getElementById("recv-client"));
}

function closeReceivableModal() {
  clearRecvEdit();
  receivableForm?.reset();
  closeCrudModal(receivableModal);
}

function openInventoryModalForNew() {
  if (blockStaffWrite()) return;
  clearInvEdit();
  inventoryForm?.reset();
  if (invQuantity) invQuantity.value = "1";
  if (invCategory) invCategory.value = "usado";
  setTodayDefaults();
  if (inventoryModalTitle) inventoryModalTitle.textContent = "Agregar equipo";
  openCrudModal(inventoryModal, invModel);
}

function openInventoryModalForEdit() {
  if (inventoryModalTitle) inventoryModalTitle.textContent = "Editar equipo";
  openCrudModal(inventoryModal, invModel);
}

function closeInventoryModal() {
  clearInvEdit();
  inventoryForm?.reset();
  if (invQuantity) invQuantity.value = "1";
  if (invCategory) invCategory.value = "usado";
  setTodayDefaults();
  closeCrudModal(inventoryModal);
}

function clearCashEdit() {
  editingCashId = null;
  if (cashEditHintEl) cashEditHintEl.hidden = true;
  if (cashFormSubmitBtn) cashFormSubmitBtn.textContent = "Guardar movimiento";
}

function beginEditCash(id) {
  const row = getCash().find((c) => String(c.id) === String(id));
  if (!row || !cashForm) return;
  editingCashId = row.id;
  if (cashType) cashType.value = row.type || "ingreso";
  if (cashDate) cashDate.value = row.date || "";
  if (cashConcept) cashConcept.value = row.concept || "";
  if (cashAmount) cashAmount.value = String(numeric(row.amount, 0));
  syncCashRepartoDestUi(cashRepartoDestOf(row));
  if (cashEditHintEl) cashEditHintEl.hidden = false;
  if (cashFormSubmitBtn) cashFormSubmitBtn.textContent = "Guardar cambios";
  openCashModalForEdit();
}

if (cashType) {
  cashType.addEventListener("change", () => syncCashRepartoDestUi());
}

function clearInvEdit() {
  editingInventoryId = null;
  if (inventorySectionHintEl) inventorySectionHintEl.hidden = false;
  if (inventoryEditHintEl) inventoryEditHintEl.hidden = true;
  if (inventoryFormSubmitBtn) inventoryFormSubmitBtn.textContent = "Agregar o actualizar stock";
}

function beginEditInventory(id) {
  if (blockStaffWrite()) return;
  const item = getInventory().find((i) => String(i.id) === String(id));
  if (!item || !inventoryForm) return;
  editingInventoryId = item.id;
  if (invModel) invModel.value = item.model || "";
  if (invColor) invColor.value = item.color || "";
  if (invStorage) invStorage.value = item.storage || "";
  if (invBattery) {
    invBattery.value = item.battery === "" || item.battery == null ? "" : String(item.battery);
  }
  if (invCategory) invCategory.value = normalizeInvCategory(item.category);
  if (invSerial) invSerial.value = resolveInventorySerial(item);
  if (invImei) invImei.value = resolveInventoryImei(item);
  if (invNotes) invNotes.value = (item.notes || "").trim();
  if (invQuantity) invQuantity.value = String(Math.max(1, numeric(item.stock, 1)));
  if (invPrice) invPrice.value = String(numeric(item.price, 0));
  if (invCost) invCost.value = String(numeric(item.cost, 0));
  if (inventorySectionHintEl) inventorySectionHintEl.hidden = true;
  if (inventoryEditHintEl) inventoryEditHintEl.hidden = false;
  if (inventoryFormSubmitBtn) inventoryFormSubmitBtn.textContent = "Guardar cambios";
  openInventoryModalForEdit();
}

function clearRecvEdit() {
  editingReceivableId = null;
  if (recvEditHintEl) recvEditHintEl.hidden = true;
  if (recvFormSubmitBtn) recvFormSubmitBtn.textContent = "Agregar pendiente";
}

function beginEditReceivable(id) {
  const row = getReceivables().find((r) => String(r.id) === String(id));
  if (!row) return;
  editingReceivableId = row.id;
  const c = document.getElementById("recv-client");
  const co = document.getElementById("recv-concept");
  const am = document.getElementById("recv-amount");
  const du = document.getElementById("recv-due");
  const ki = document.getElementById("recv-kind");
  const no = document.getElementById("recv-notes");
  if (c) c.value = row.clientName || "";
  if (co) co.value = row.concept || "";
  if (am) am.value = String(numeric(row.amountPending, 0));
  if (du) du.value = row.dueDate || "";
  if (ki) ki.value = row.kind || "cuotas";
  if (no) no.value = row.notes || "";
  if (recvEditHintEl) recvEditHintEl.hidden = false;
  if (recvFormSubmitBtn) recvFormSubmitBtn.textContent = "Guardar cambios";
  openReceivableModalForEdit();
}

function clearInvoiceEdit() {
  editingInvoiceId = null;
  if (invoiceEditHintEl) invoiceEditHintEl.hidden = true;
  if (invoiceFormSubmitBtn) invoiceFormSubmitBtn.textContent = "Emitir comprobante";
  if (invoiceSaleId) invoiceSaleId.disabled = false;
  if (invoiceType) invoiceType.disabled = false;
}

function beginEditInvoice(id) {
  const inv = getInvoices().find((x) => String(x.id) === String(id));
  if (!inv || inv.status === "anulado") {
    alert("No se puede editar este comprobante.");
    return;
  }
  editingInvoiceId = inv.id;
  refreshInvoiceSaleOptions();
  if (invoiceSaleId) {
    invoiceSaleId.value = String(inv.saleId);
    invoiceSaleId.disabled = true;
  }
  if (invoiceType) {
    invoiceType.value = inv.invoiceType || "ticket";
    invoiceType.disabled = true;
  }
  if (invoiceDate) invoiceDate.value = inv.issueDate || "";
  if (invoiceTaxPct) invoiceTaxPct.value = String(numeric(inv.taxPct, 0));
  if (invoiceNotes) invoiceNotes.value = inv.notes || "";
  if (invoiceEditHintEl) invoiceEditHintEl.hidden = false;
  if (invoiceFormSubmitBtn) invoiceFormSubmitBtn.textContent = "Guardar cambios";
  openInvoiceModalForEdit();
}

btnOpenCashModal?.addEventListener("click", () => openCashModalForNew());
btnOpenInvoiceModal?.addEventListener("click", () => openInvoiceModalForNew());
btnOpenReceivableModal?.addEventListener("click", () => openReceivableModalForNew());
btnOpenInventoryModal?.addEventListener("click", () => openInventoryModalForNew());

wireCrudModal(cashModal, {
  backdrop: cashModalBackdrop,
  closeEls: [cashModalClose, cashModalCancel],
  onClose: closeCashModal,
});
wireCrudModal(invoiceModal, {
  backdrop: invoiceModalBackdrop,
  closeEls: [invoiceModalClose, invoiceModalCancel],
  onClose: closeInvoiceModal,
});
wireCrudModal(receivableModal, {
  backdrop: receivableModalBackdrop,
  closeEls: [receivableModalClose, receivableModalCancel],
  onClose: closeReceivableModal,
});
wireCrudModal(inventoryModal, {
  backdrop: inventoryModalBackdrop,
  closeEls: [inventoryModalClose, inventoryModalCancel],
  onClose: closeInventoryModal,
});

cashForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = Number(cashAmount.value);
  if (!cashDate.value || !cashConcept.value.trim() || amount < 0) {
    alert("Completa los campos de caja.");
    return;
  }

  const repartoDestForSave = normalizeStoredRepartoDest(
    cashType.value,
    cashRepartoDest?.value,
    cashType.value === "egreso" ? repartoDestToEgresoKind(cashRepartoDest?.value) : null
  );
  const egresoKindForSave = cashType.value === "egreso" ? repartoDestToEgresoKind(repartoDestForSave) : null;

  if (editingCashId) {
    if (useCloud) {
      try {
        const userId = await getUserId();
        let payload = {
          movement_type: cashType.value,
          movement_date: cashDate.value,
          concept: conceptWithCashTotalMark(cashConcept.value, repartoDestForSave),
          amount,
          egreso_kind: egresoKindForSave,
          reparto_dest: repartoDestForSave,
        };
        let { error } = await supabaseClient
          .from("cash_movements")
          .update(payload)
          .eq("id", editingCashId)
          .eq("user_id", userId);
        if (error && /reparto_dest|schema cache/i.test(error.message || "")) {
          const { reparto_dest: _omitDest, ...legacyPayload } = payload;
          ({ error } = await supabaseClient
            .from("cash_movements")
            .update(legacyPayload)
            .eq("id", editingCashId)
            .eq("user_id", userId));
        }
        if (error) throw error;
      } catch (e) {
        alert(e.message || "Error al actualizar caja.");
        return;
      }
    } else {
      const cash = readList(KEYS.cash);
      const item = cash.find((c) => String(c.id) === String(editingCashId));
      if (item) {
        item.type = cashType.value;
        item.date = cashDate.value;
        item.concept = cashConcept.value.trim();
        item.amount = amount;
        item.repartoDest = repartoDestForSave;
        if (cashType.value === "egreso") item.egresoKind = egresoKindForSave;
        else delete item.egresoKind;
        writeList(KEYS.cash, cash);
      }
    }
    clearCashEdit();
    resetCashFormDefaults();
    closeCrudModal(cashModal);
    await afterDataChange();
    return;
  }

  if (useCloud) {
    try {
      const userId = await getUserId();
      let payload = {
        user_id: userId,
        movement_type: cashType.value,
        movement_date: cashDate.value,
        concept: conceptWithCashTotalMark(cashConcept.value, repartoDestForSave),
        amount,
        egreso_kind: egresoKindForSave,
        reparto_dest: repartoDestForSave,
      };
      let { error } = await supabaseClient.from("cash_movements").insert(payload);
      if (error && /reparto_dest|schema cache/i.test(error.message || "")) {
        const { reparto_dest: _omitDest, ...legacyPayload } = payload;
        ({ error } = await supabaseClient.from("cash_movements").insert(legacyPayload));
      }
      if (error) throw error;
    } catch (e) {
      alert(e.message || "Error al guardar caja.");
      return;
    }
  } else {
    const cash = readList(KEYS.cash);
    const row = {
      id: crypto.randomUUID(),
      type: cashType.value,
      date: cashDate.value,
      concept: cashConcept.value.trim(),
      amount,
      repartoDest: repartoDestForSave,
    };
    if (cashType.value === "egreso") row.egresoKind = egresoKindForSave;
    cash.unshift(row);
    writeList(KEYS.cash, cash);
  }

  resetCashFormDefaults();
  closeCrudModal(cashModal);
  await afterDataChange();
});

function inventoryUnitExists(serial, imei, excludeId) {
  const ser = String(serial || "").trim().toUpperCase();
  const imeiDigits = normalizeImeiDigits(imei);
  return getInventory().some((i) => {
    if (String(i.id) === String(excludeId || "")) return false;
    if (ser && resolveInventorySerial(i) === ser) return true;
    if (imeiDigits && resolveInventoryImei(i) === imeiDigits) return true;
    return false;
  });
}

function setInvBulkStatus(msg, isError) {
  if (!invBulkStatus) return;
  invBulkStatus.hidden = !msg;
  invBulkStatus.textContent = msg || "";
  invBulkStatus.classList.toggle("inv-bulk-status--error", Boolean(isError));
}

function resetInvBulkModal() {
  if (invBulkPaste) invBulkPaste.value = "";
  if (invBulkFile) invBulkFile.value = "";
  if (invBulkFileNames) invBulkFileNames.textContent = "O pegá el reporte abajo";
  renderInvBulkPreview([]);
  setInvBulkStatus("", false);
  if (invBulkImportBtn) invBulkImportBtn.hidden = true;
}

function openInvBulkModal() {
  if (blockStaffWrite("En el acceso de empleados no se puede cargar stock.")) return;
  if (!invBulkModal) return;
  resetInvBulkModal();
  invBulkModal.hidden = false;
  invBulkModal.setAttribute("aria-hidden", "false");
  syncBodyModalLock();
  invBulkPaste?.focus();
}

function hideInvBulkModal() {
  if (!invBulkModal) return;
  invBulkModal.hidden = true;
  invBulkModal.setAttribute("aria-hidden", "true");
  syncBodyModalLock();
  resetInvBulkModal();
}

async function appendInvBulkFilesToPaste(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const chunks = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const t = String(text || "").trim();
      if (t) chunks.push(t);
    } catch (e) {
      console.warn("No se pudo leer archivo:", file.name, e);
    }
  }
  if (!chunks.length) {
    setInvBulkStatus("No se pudo leer el contenido de los archivos.", true);
    return;
  }
  const merged = chunks.join("\n\n");
  if (invBulkPaste) {
    const prev = invBulkPaste.value.trim();
    invBulkPaste.value = prev ? `${prev}\n\n${merged}` : merged;
  }
  if (invBulkFileNames) {
    invBulkFileNames.textContent =
      files.length === 1 ? files[0].name : `${files.length} archivos cargados en el cuadro de texto`;
  }
  setInvBulkStatus("Archivos cargados. Revisá el texto y tocá «Analizar».", false);
}

function renderInvBulkPreview(rows) {
  invBulkPreviewRows = rows;
  if (!invBulkPreviewBody || !invBulkPreviewWrap) return;
  invBulkPreviewBody.innerHTML = "";
  const hasRows = rows.length > 0;
  invBulkPreviewWrap.hidden = !hasRows;
  if (invBulkImportBtn) invBulkImportBtn.hidden = !rows.some((r) => r.status === "ok");

  rows.forEach((row, idx) => {
    const p = row.parsed;
    const tr = document.createElement("tr");
    if (row.status === "ok" && p?.valid) {
      const warn = (p.warnings || []).join("; ");
      const badge = warn
        ? `<span class="inv-bulk-badge inv-bulk-badge--warn" title="${escapeHtml(warn)}">Listo · sin IMEI</span>`
        : `<span class="inv-bulk-badge inv-bulk-badge--ok">Listo</span>`;
      tr.innerHTML = `
        <td>${escapeHtml(p.model)}</td>
        <td>${escapeHtml(p.color)}</td>
        <td>${escapeHtml(p.storage)}</td>
        <td>${p.battery ? `${escapeHtml(p.battery)}%` : '<span class="muted">—</span>'}</td>
        <td><code>${escapeHtml(p.serial)}</code></td>
        <td>${p.imei ? `<code>${escapeHtml(p.imei)}</code>` : '<span class="muted">—</span>'}</td>
        <td class="muted inv-bulk-notes-cell" title="${escapeHtml(p.notes)}">${escapeHtml(
          p.notes.length > 40 ? `${p.notes.slice(0, 37)}…` : p.notes || "—"
        )}</td>
        <td>${badge}</td>`;
    } else {
      const err = row.status === "duplicate" ? "Ya en inventario" : (p?.errors || [row.message || "Error"]).join("; ");
      tr.innerHTML = `
        <td colspan="7" class="muted">${escapeHtml(p?.model || p?.serial || `Reporte ${idx + 1}`)} — ${escapeHtml(err)}</td>
        <td><span class="inv-bulk-badge inv-bulk-badge--err">${row.status === "duplicate" ? "Duplicado" : "Revisar"}</span></td>`;
    }
    invBulkPreviewBody.appendChild(tr);
  });
}

function parseInvBulkPaste() {
  const text = invBulkPaste?.value?.trim() || "";
  if (!text) {
    setInvBulkStatus("Pegá al menos un reporte completo.", true);
    renderInvBulkPreview([]);
    return;
  }
  const chunks = splitDiagnosticReports(text);
  const rows = chunks.map((chunk, i) => {
    const parsed = parseDeviceDiagnosticReport(chunk);
    if (!parsed.valid) {
      return { parsed, status: "error", message: parsed.errors.join("; ") };
    }
    if (inventoryUnitExists(parsed.serial, parsed.imei)) {
      return { parsed, status: "duplicate" };
    }
    const dupInBatch = chunks.slice(0, i).some((c) => {
      const p = parseDeviceDiagnosticReport(c);
      return p.valid && p.serial && p.serial === parsed.serial;
    });
    if (dupInBatch) {
      return { parsed, status: "duplicate", message: "Serie repetida en el mismo pegado" };
    }
    return { parsed, status: "ok" };
  });
  const ok = rows.filter((r) => r.status === "ok").length;
  const dup = rows.filter((r) => r.status === "duplicate").length;
  const err = rows.filter((r) => r.status === "error").length;
  const parts = [`${ok} listo(s) para cargar`];
  if (dup) parts.push(`${dup} duplicado(s)`);
  if (err) parts.push(`${err} con error`);
  setInvBulkStatus(parts.join(" · "), err > 0 && ok === 0);
  renderInvBulkPreview(rows);
}

async function saveInventoryUnitLocalOrCloud({
  model,
  color,
  storage,
  battery,
  serial,
  imei,
  notes,
  quantity,
  price,
  cost,
  category,
  flagTecnico,
  flagOnline,
  flagVendible,
}) {
  const serialNorm = String(serial || "").trim().toUpperCase();
  const imeiNorm = normalizeImeiDigits(imei);
  const notesNorm = String(notes || "").trim();
  const meta = invMetaFieldsForSave({
    category,
    flagTecnico,
    flagOnline,
    flagVendible,
    price,
  });
  if (inventoryUnitExists(serialNorm, imeiNorm)) {
    throw new Error(
      `Ya existe en inventario${serialNorm ? ` (serie ${serialNorm})` : ""}${imeiNorm ? ` (IMEI ${imeiNorm})` : ""}.`
    );
  }

  if (useCloud) {
    const userId = await getUserId();
    const inventory = getInventory();
    const key = getInventoryKey(model, color, storage, battery, serialNorm, imeiNorm);
    const found = inventory.find(
      (item) =>
        getInventoryKey(
          item.model,
          item.color,
          item.storage,
          item.battery,
          resolveInventorySerial(item),
          resolveInventoryImei(item)
        ) === key
    );
    const arsFld = computeInventoryArsFields(price);
    if (found) {
      const { error } = await supabaseClient
        .from("inventory_items")
        .update({
          stock: found.stock + quantity,
          price,
          cost,
          serial: serialNorm || resolveInventorySerial(found) || "",
          imei: imeiNorm || resolveInventoryImei(found) || "",
          notes: notesNorm || found.notes || "",
          ...meta,
          ...arsFld,
          updated_at: new Date().toISOString(),
        })
        .eq("id", found.id)
        .eq("user_id", userId);
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from("inventory_items").insert({
        user_id: userId,
        model,
        color,
        storage,
        battery,
        serial: serialNorm,
        imei: imeiNorm,
        notes: notesNorm,
        stock: quantity,
        price,
        cost,
        ...meta,
        ...arsFld,
      });
      if (error) throw error;
    }
  } else {
    const inventory = readList(KEYS.inventory);
    const key = getInventoryKey(model, color, storage, battery, serialNorm, imeiNorm);
    const found = inventory.find(
      (item) =>
        getInventoryKey(
          item.model,
          item.color,
          item.storage,
          item.battery,
          resolveInventorySerial(item),
          resolveInventoryImei(item)
        ) === key
    );
    const ars = localArsCamelFromUsd(price);
    const metaCamel = {
      category: meta.category,
      flagTecnico: meta.flag_tecnico,
      flagOnline: meta.flag_online,
      flagVendible: meta.flag_vendible,
    };
    if (found) {
      found.stock += quantity;
      found.price = price;
      found.cost = cost;
      if (serialNorm) found.serial = serialNorm;
      if (imeiNorm) found.imei = imeiNorm;
      if (notesNorm) found.notes = notesNorm;
      Object.assign(found, ars, metaCamel);
    } else {
      inventory.push({
        id: crypto.randomUUID(),
        model,
        color,
        storage,
        battery,
        serial: serialNorm,
        imei: imeiNorm,
        notes: notesNorm,
        stock: quantity,
        price,
        cost,
        createdAt: new Date().toISOString(),
        ...metaCamel,
        ...ars,
      });
    }
    writeList(KEYS.inventory, inventory);
  }

  const invId = found?.id || null;
  void logDeviceHistoryEvent({
    eventType: "ingreso",
    serial: serialNorm,
    imei: imeiNorm,
    inventoryItemId: invId,
    model,
    color,
    storage,
    battery: String(battery ?? ""),
    detail: found ? `Stock +${quantity}` : "Alta en inventario",
  });
}

async function importInvBulkPreview() {
  const rows = invBulkPreviewRows.filter((r) => r.status === "ok" && r.parsed?.valid);
  if (!rows.length) {
    alert("No hay equipos listos para importar. Usá «Analizar reportes» primero.");
    return;
  }
  let added = 0;
  const failures = [];
  for (const row of rows) {
    const p = row.parsed;
    try {
      await saveInventoryUnitLocalOrCloud({
        model: p.model,
        color: p.color,
        storage: p.storage,
        battery: p.battery,
        serial: p.serial,
        imei: p.imei,
        notes: p.notes,
        quantity: 1,
        price: 0,
        cost: 0,
        category: "usado",
        flagTecnico: false,
        flagOnline: true,
        flagVendible: false,
      });
      added += 1;
    } catch (e) {
      failures.push(`${p.serial || p.imei}: ${e.message || e}`);
    }
  }
  await afterDataChange();
  if (failures.length) {
    alert(`Se agregaron ${added} equipo(s).\n\nNo se pudieron cargar:\n${failures.join("\n")}`);
    setInvBulkStatus(`Se agregaron ${added} de ${rows.length}. Revisá los errores.`, true);
  } else {
    hideInvBulkModal();
    if (added > 0) {
      alert(`Se agregaron ${added} equipo(s). Completá precios en la tabla cuando quieras.`);
    }
  }
}

if (btnOpenInvBulkModal) {
  btnOpenInvBulkModal.addEventListener("click", () => openInvBulkModal());
}
if (invBulkModalClose) invBulkModalClose.addEventListener("click", () => hideInvBulkModal());
if (invBulkModalCancel) invBulkModalCancel.addEventListener("click", () => hideInvBulkModal());
if (invBulkModalBackdrop) invBulkModalBackdrop.addEventListener("click", () => hideInvBulkModal());

if (invUnitModalClose) invUnitModalClose.addEventListener("click", () => hideInvUnitModal());
if (invUnitModalDone) invUnitModalDone.addEventListener("click", () => hideInvUnitModal());
if (invUnitModalBackdrop) invUnitModalBackdrop.addEventListener("click", () => hideInvUnitModal());
if (invUnitModalEdit) {
  invUnitModalEdit.addEventListener("click", () => {
    const id = invUnitModalOpenId;
    if (!id) return;
    hideInvUnitModal();
    beginEditInventory(id);
  });
}
if (invUnitModalCopyMsg) {
  invUnitModalCopyMsg.addEventListener("click", () => {
    const id = invUnitModalOpenId;
    if (!id) return;
    void copyClientOfferMessage(id, invUnitModalCopyMsg);
  });
}
if (invUnitModalDelete) {
  invUnitModalDelete.addEventListener("click", async () => {
    if (blockStaffWrite()) return;
    const id = invUnitModalOpenId;
    if (!id) return;
    const item = getInventory().find((i) => String(i.id) === String(id));
    if (!item) return;
    const label = `${item.model} · ${item.color} · ${item.storage} (${item.stock} u.)`;
    if (!confirm(`¿Eliminar por completo esta fila del inventario?\n\n${label}`)) return;
    void logDeviceHistoryEvent({
      eventType: "baja",
      serial: resolveInventorySerial(item),
      imei: resolveInventoryImei(item),
      inventoryItemId: item.id,
      model: item.model,
      color: item.color,
      storage: item.storage,
      battery: item.battery ?? "",
      detail: "Eliminado del inventario",
    });
    hideInvUnitModal();
    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient
          .from("inventory_items")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);
        if (error) throw error;
      } catch (e) {
        alert(e.message || "Error al eliminar del inventario.");
        return;
      }
    } else {
      const localInv = readList(KEYS.inventory).filter((i) => i.id !== id);
      writeList(KEYS.inventory, localInv);
    }
    await afterDataChange();
  });
}

if (invUnitModalBody) {
  invUnitModalBody.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const actionEl = target.closest("[data-action]");
    const action = actionEl instanceof HTMLElement ? actionEl.dataset.action : "";
    const id = actionEl?.dataset?.id || invUnitModalOpenId;
    const item = getInventory().find((i) => String(i.id) === String(id));
    if (!item) return;
    if (action === "copy-offer-msg") {
      void copyClientOfferMessage(id, actionEl);
      return;
    }
    if (action === "copy-serial" || action === "copy-imei") {
      const text = action === "copy-serial" ? resolveInventorySerial(item) : resolveInventoryImei(item);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        alert(text);
      }
      return;
    }
    if (action === "view-device-history") {
      const serial = actionEl?.dataset?.serial || resolveInventorySerial(item);
      const imei = actionEl?.dataset?.imei || resolveInventoryImei(item);
      hideInvUnitModal();
      openDeviceHistoryForIdentity(serial, imei);
    }
  });
  invUnitModalBody.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.action !== "inv-flag") return;
    const flag = input.dataset.flag;
    const id = input.dataset.id || invUnitModalOpenId;
    if (!flag || !id) return;
    const desired = input.checked;
    void persistInvUnitFlag(id, flag, desired).then((ok) => {
      if (!ok) input.checked = !desired;
    });
  });
}

if (btnOpenDeviceHistoryModal) {
  btnOpenDeviceHistoryModal.addEventListener("click", () => openDeviceHistoryModal());
}
if (deviceHistoryModalClose) {
  deviceHistoryModalClose.addEventListener("click", () => hideDeviceHistoryModal());
}
if (deviceHistoryModalDone) {
  deviceHistoryModalDone.addEventListener("click", () => hideDeviceHistoryModal());
}
if (deviceHistoryModalBackdrop) {
  deviceHistoryModalBackdrop.addEventListener("click", () => hideDeviceHistoryModal());
}
if (invBulkFileTrigger && invBulkFile) {
  invBulkFileTrigger.addEventListener("click", () => invBulkFile.click());
}
if (invBulkFile) {
  invBulkFile.addEventListener("change", () => {
    if (invBulkFile.files?.length) appendInvBulkFilesToPaste(invBulkFile.files);
  });
}
if (invBulkParseBtn) {
  invBulkParseBtn.addEventListener("click", () => parseInvBulkPaste());
}
if (invBulkImportBtn) {
  invBulkImportBtn.addEventListener("click", () => importInvBulkPreview());
}

inventoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (blockStaffWrite()) return;
  const model = invModel.value.trim();
  const color = invColor.value.trim();
  const storage = invStorage.value.trim();
  const battery = invBattery.value === "" ? "" : String(invBattery.value);
  const category = invCategory ? invCategory.value : "usado";
  const serial = invSerial ? invSerial.value.trim().toUpperCase() : "";
  const imei = invImei ? normalizeImeiDigits(invImei.value) : "";
  const notes = invNotes ? invNotes.value.trim() : "";
  const editingItem = editingInventoryId
    ? getInventory().find((i) => String(i.id) === String(editingInventoryId))
    : null;
  const quantity = Number(invQuantity.value);
  const price = invPrice.value === "" ? 0 : Number(invPrice.value);
  const costRaw = invCost.value === "" ? 0 : Number(invCost.value);

  if (!model || !color || !storage || quantity <= 0 || Number.isNaN(price) || price < 0 || costRaw < 0) {
    alert("Completa correctamente los datos de inventario.");
    return;
  }
  if (invImei?.value?.trim() && !imei) {
    alert("El IMEI debe tener 15 dígitos.");
    return;
  }
  if (inventoryUnitExists(serial, imei, editingInventoryId)) {
    alert("Esa serie o IMEI ya está cargado en inventario.");
    return;
  }

  const cost = costRaw;
  const metaPatch = invMetaFieldsForSave({
    category,
    flagTecnico: editingItem?.flagTecnico,
    flagOnline: editingItem?.flagOnline,
    flagVendible: editingItem?.flagVendible,
    price,
  });
  const metaCamel = {
    category: metaPatch.category,
    flagTecnico: metaPatch.flag_tecnico,
    flagOnline: metaPatch.flag_online,
    flagVendible: metaPatch.flag_vendible,
  };

  if (editingInventoryId) {
    if (useCloud) {
      try {
        const userId = await getUserId();
        const arsFld = computeInventoryArsFields(price);
        const { error } = await supabaseClient
          .from("inventory_items")
          .update({
            model,
            color,
            storage,
            battery,
            serial,
            imei,
            notes,
            stock: quantity,
            price,
            cost,
            ...metaPatch,
            ...arsFld,
            updated_at: new Date().toISOString(),
          })
          .eq("id", editingInventoryId)
          .eq("user_id", userId);
        if (error) throw error;
        void logDeviceHistoryEvent({
          eventType: "actualizado",
          serial,
          imei,
          inventoryItemId: editingInventoryId,
          model,
          color,
          storage,
          battery,
          detail: "Datos actualizados en inventario",
        });
      } catch (e) {
        alert(e.message || "Error al actualizar inventario.");
        return;
      }
    } else {
      const inventory = readList(KEYS.inventory);
      const idx = inventory.findIndex((i) => String(i.id) === String(editingInventoryId));
      if (idx >= 0) {
        inventory[idx] = {
          ...inventory[idx],
          model,
          color,
          storage,
          battery,
          serial,
          imei,
          notes,
          stock: quantity,
          price,
          cost,
          ...metaCamel,
          ...localArsCamelFromUsd(price),
        };
        writeList(KEYS.inventory, inventory);
      }
      void logDeviceHistoryEvent({
        eventType: "actualizado",
        serial,
        imei,
        inventoryItemId: editingInventoryId,
        model,
        color,
        storage,
        battery,
        detail: "Datos actualizados en inventario",
      });
    }
    clearInvEdit();
    inventoryForm.reset();
    if (invQuantity) invQuantity.value = "1";
    if (invCategory) invCategory.value = "usado";
    closeCrudModal(inventoryModal);
    await afterDataChange();
    return;
  }

  try {
    await saveInventoryUnitLocalOrCloud({
      model,
      color,
      storage,
      battery,
      serial,
      imei,
      notes,
      quantity,
      price,
      cost,
      category,
      flagTecnico: false,
      flagOnline: true,
      flagVendible: undefined,
    });
  } catch (e) {
    alert(e.message || "Error al guardar inventario.");
    return;
  }

  inventoryForm.reset();
  invQuantity.value = "1";
  closeCrudModal(inventoryModal);
  await afterDataChange();
});

salesBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const clientBtn = target.closest(".sale-client-btn");
  if (clientBtn) {
    const name = clientBtn.dataset.client || "";
    window.__businessExtras?.openClientProfile?.(name);
    return;
  }
  const editSale = target.closest(".edit-sale-btn");
  if (editSale) {
    const sid = editSale.dataset.id;
    if (sid) openSaleModalForEdit(sid);
    return;
  }
  if (!target.classList.contains("delete-btn")) return;
  const id = target.dataset.id;

  if (useCloud) {
    try {
      const userId = await getUserId();
      const saleToDelete = getSales().find((s) => s.id === id);
      if (!saleToDelete) return;

      const devDel = resolveSaleDeviceIdentity(saleToDelete);
      void logDeviceHistoryEvent({
        eventType: "venta_anulada",
        serial: devDel.serial,
        imei: devDel.imei,
        saleId: id,
        clientName: saleToDelete.client || "",
        model: saleToDelete.model,
        color: saleToDelete.color || "",
        storage: saleToDelete.storage || "",
        battery: saleToDelete.battery ?? "",
        detail: "Venta eliminada",
      });
      if (saleToDelete.deductFromInventory !== false) {
        void logDeviceHistoryEvent({
          eventType: "devolucion_stock",
          serial: devDel.serial,
          imei: devDel.imei,
          model: saleToDelete.model,
          color: saleToDelete.color || "",
          storage: saleToDelete.storage || "",
          battery: saleToDelete.battery ?? "",
          detail: "Unidad devuelta al inventario al anular la venta",
        });
      }

      await removeCommissionCashRowsCloud(userId, id);

      const { error: delErr } = await supabaseClient.from("sales").delete().eq("id", id).eq("user_id", userId);
      if (delErr) throw delErr;

      if (saleToDelete.deductFromInventory !== false) {
        const key = getInventoryKey(
          saleToDelete.model,
          saleToDelete.color || "",
          saleToDelete.storage || "",
          saleToDelete.battery || ""
        );
        const inv = getInventory();
        const found = inv.find((item) => getInventoryKey(item.model, item.color, item.storage, item.battery) === key);
        if (found) {
          const { error: invErr } = await supabaseClient
            .from("inventory_items")
            .update({
              stock: found.stock + saleToDelete.quantity,
              updated_at: new Date().toISOString(),
            })
            .eq("id", found.id)
            .eq("user_id", userId);
          if (invErr) throw invErr;
        } else {
          const arsFld = computeInventoryArsFields(saleToDelete.unitSale);
          const { error: insErr } = await supabaseClient.from("inventory_items").insert({
            user_id: userId,
            model: saleToDelete.model,
            color: saleToDelete.color || "Sin color",
            storage: saleToDelete.storage || "Sin almacenamiento",
            battery: saleToDelete.battery || "",
            stock: saleToDelete.quantity,
            price: saleToDelete.unitSale,
            cost: saleToDelete.unitCost,
            ...arsFld,
          });
          if (insErr) throw insErr;
        }
      }

      if (saleRecordedTradeInToInventory(saleToDelete)) {
        await refreshCloud();
        mirrorCloudCachesToLocal();
        await cloudReverseTradeInInventory(userId, saleToDelete);
      }
      const { error: invDeleteErr } = await supabaseClient
        .from("invoices")
        .delete()
        .eq("sale_id", id)
        .eq("user_id", userId);
      if (invDeleteErr && !/relation|does not exist|schema cache|not find.*invoices/i.test(invDeleteErr.message || "")) {
        throw invDeleteErr;
      }
    } catch (e) {
      alert(e.message || "Error al eliminar venta.");
      return;
    }
  } else {
    const sales = readList(KEYS.sales);
    const saleToDelete = sales.find((s) => s.id === id);
    if (saleToDelete) {
      const devDel = resolveSaleDeviceIdentity(saleToDelete);
      void logDeviceHistoryEvent({
        eventType: "venta_anulada",
        serial: devDel.serial,
        imei: devDel.imei,
        saleId: id,
        clientName: saleToDelete.client || "",
        model: saleToDelete.model,
        color: saleToDelete.color || "",
        storage: saleToDelete.storage || "",
        battery: saleToDelete.battery ?? "",
        detail: "Venta eliminada",
      });
      if (saleToDelete.deductFromInventory !== false) {
        void logDeviceHistoryEvent({
          eventType: "devolucion_stock",
          serial: devDel.serial,
          imei: devDel.imei,
          model: saleToDelete.model,
          color: saleToDelete.color || "",
          storage: saleToDelete.storage || "",
          battery: saleToDelete.battery ?? "",
          detail: "Unidad devuelta al inventario al anular la venta",
        });
      }
    }
    const nextSales = sales.filter((s) => s.id !== id);
    if (saleToDelete && saleToDelete.deductFromInventory !== false) {
      const inventory = readList(KEYS.inventory);
      const key = getInventoryKey(
        saleToDelete.model,
        saleToDelete.color || "",
        saleToDelete.storage || "",
        saleToDelete.battery || ""
      );
      const found = inventory.find((item) => getInventoryKey(item.model, item.color, item.storage, item.battery) === key);
      if (found) {
        found.stock += saleToDelete.quantity;
      } else {
        inventory.push({
          id: crypto.randomUUID(),
          model: saleToDelete.model,
          color: saleToDelete.color || "Sin color",
          storage: saleToDelete.storage || "Sin almacenamiento",
          battery: saleToDelete.battery || "",
          stock: saleToDelete.quantity,
          price: saleToDelete.unitSale,
          cost: saleToDelete.unitCost,
        });
      }
      writeList(KEYS.inventory, inventory);
    }
    if (saleToDelete) {
      const invTi = readList(KEYS.inventory);
      localReverseTradeInInventory(invTi, saleToDelete);
      writeList(KEYS.inventory, invTi);
    }
    removeCommissionCashRowsLocal(id);
    writeList(KEYS.sales, nextSales);
    const invoices = getInvoices().filter((inv) => String(inv.saleId) !== String(id));
    writeList(KEYS.invoices, invoices);
  }

  await afterDataChange();
});

if (invoicesBody) {
  invoicesBody.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains("invoice-pdf-btn")) {
      const id = target.dataset.id;
      if (!id) return;
      downloadInvoicePdf(id);
      return;
    }
    if (target.classList.contains("invoice-edit-btn")) {
      const id = target.dataset.id;
      if (id) beginEditInvoice(id);
      return;
    }
    if (!target.classList.contains("invoice-void-btn")) return;
    const id = target.dataset.id;
    if (!id) return;
    if (!confirm("¿Anular este comprobante? La acción queda registrada.")) return;
    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient
          .from("invoices")
          .update({ status: "anulado" })
          .eq("id", id)
          .eq("user_id", userId);
        if (error) throw error;
      } catch (e) {
        alert(e.message || "Error al anular comprobante.");
        return;
      }
    } else {
      const list = getInvoices();
      const found = list.find((x) => String(x.id) === String(id));
      if (!found) return;
      found.status = "anulado";
      writeList(KEYS.invoices, list);
    }
    await afterDataChange();
  });
}

cashBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const editCash = target.closest(".edit-cash-btn");
  if (editCash) {
    const cid = editCash.dataset.id;
    if (cid) beginEditCash(cid);
    return;
  }
  if (!target.classList.contains("delete-btn")) return;
  const id = target.dataset.id;

  if (useCloud) {
    try {
      const userId = await getUserId();
      const { error } = await supabaseClient.from("cash_movements").delete().eq("id", id).eq("user_id", userId);
      if (error) throw error;
    } catch (e) {
      alert(e.message || "Error al eliminar movimiento.");
      return;
    }
  } else {
    const cash = readList(KEYS.cash).filter((c) => c.id !== id);
    writeList(KEYS.cash, cash);
  }

  await afterDataChange();
});

/**
 * Antes de guardar: vuelca serie/IMEI y datos del formulario en la línea del carrito.
 * En edición el carrito no se actualiza solo al tipear en el formulario.
 */
function syncSaleFormIntoCartIfNeeded() {
  const model = (saleModel?.value || "").trim();
  if (!model) return saleCart.length > 0;

  if (saleCart.length === 0) {
    return addFilledSaleFormToCart();
  }

  if (saleModalEditMode || saleCart.length === 1) {
    const line = saleCart[0];
    const devId = parseDeviceIdentity(saleImei?.value || "");
    line.model = model;
    line.color = (saleColor?.value || "").trim();
    line.storage = (saleStorage?.value || "").trim();
    line.battery = (saleBattery?.value || "").trim();
    line.serial = devId.serial;
    line.imei = devId.imei;
    line.quantity = Math.max(1, Number(saleQuantity?.value) || 1);
    line.unitSale = Number(salePrice?.value) || 0;
    const unitCostRaw = saleCost?.value === "" ? NaN : Number(saleCost?.value);
    if (!Number.isNaN(unitCostRaw) && unitCostRaw >= 0) line.unitCost = unitCostRaw;
    renderSaleCart();
    return true;
  }

  return true;
}

/** Agrega al carrito la línea del formulario de venta (misma regla que «Agregar al carrito»). */
function addFilledSaleFormToCart() {
  const quantity = Number(saleQuantity?.value || 1);
  const unitSale = Number(salePrice?.value);
  const unitCostRaw = saleCost?.value === "" ? NaN : Number(saleCost?.value);
  const model = (saleModel?.value || "").trim();
  const color = (saleColor?.value || "").trim();
  const storage = (saleStorage?.value || "").trim();
  const battery = (saleBattery?.value || "").trim();
  const pickedId = salePickInventory?.value ? String(salePickInventory.value).trim() : "";

  if (!model || !color || !storage || quantity <= 0 || unitSale < 0) {
    alert("Completá modelo, color, almacenamiento, cantidad y precio para agregar al carrito.");
    return false;
  }

  const inventory = getInventory();
  const res = resolveInventoryMatchForSaleLine(inventory, pickedId, model, color, storage, battery, quantity);
  if (res.cancelled) return false;

  let unitCost = Number.isNaN(unitCostRaw) ? NaN : unitCostRaw;
  if (Number.isNaN(unitCost)) {
    unitCost = res.match ? Number(res.match.cost || 0) : NaN;
  }
  if (Number.isNaN(unitCost) || unitCost < 0) {
    alert("Indicá el costo unitario (compra) o elegí una fila de inventario con costo.");
    return false;
  }

  const devId = parseDeviceIdentity(saleImei ? saleImei.value : "");
  saleCart.push({
    id: crypto.randomUUID(),
    inventoryId: pickedId,
    model,
    color,
    storage,
    battery,
    serial: devId.serial,
    imei: devId.imei,
    quantity,
    unitSale,
    unitCost,
    deductInventory: res.deductInventory,
    matchId: res.match ? res.match.id : null,
  });
  renderSaleCart();
  updateSaleCheckoutSummary();
  return true;
}

if (inventoryStock) {
  inventoryStock.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const groupBtn = target.closest(".inv-cat-row");
  if (groupBtn instanceof HTMLButtonElement && groupBtn.dataset.modelKey) {
    toggleInvModelGroup(groupBtn.dataset.modelKey);
    return;
  }
  const actionEl = target.closest("[data-action]");
  const action = actionEl instanceof HTMLElement ? actionEl.dataset.action : "";
  if (!action) return;

  const id = actionEl?.dataset?.id;
  const inventory = getInventory();
  const item = inventory.find((i) => String(i.id) === String(id));
  if (!item) return;

  if (action === "toggle-wa-select") {
    event.preventDefault();
    toggleInvWaSelection(id);
    return;
  }

  if (action === "copy-offer-msg") {
    event.preventDefault();
    event.stopPropagation();
    void copyClientOfferMessage(id, actionEl);
    return;
  }

  if (action === "open-inv-detail" || action === "toggle-card-expand") {
    if (invWaSelectMode) {
      toggleInvWaSelection(id);
      return;
    }
    openInvUnitModal(id);
    return;
  }

  if (action === "edit-inventory") {
    if (blockStaffWrite()) return;
    hideInvUnitModal();
    beginEditInventory(id);
    return;
  }

  if (action === "copy-serial" || action === "copy-imei") {
    const text = action === "copy-serial" ? resolveInventorySerial(item) : resolveInventoryImei(item);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      alert(text);
    }
    return;
  }

  if (action === "delete-inventory") {
    if (blockStaffWrite()) return;
    const label = `${item.model} · ${item.color} · ${item.storage} (${item.stock} u.)`;
    if (!confirm(`¿Eliminar por completo esta fila del inventario?\n\n${label}`)) return;
    void logDeviceHistoryEvent({
      eventType: "baja",
      serial: resolveInventorySerial(item),
      imei: resolveInventoryImei(item),
      inventoryItemId: item.id,
      model: item.model,
      color: item.color,
      storage: item.storage,
      battery: item.battery ?? "",
      detail: "Eliminado del inventario",
    });
    hideInvUnitModal();
    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient
          .from("inventory_items")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);
        if (error) throw error;
      } catch (e) {
        alert(e.message || "Error al eliminar del inventario.");
        return;
      }
    } else {
      const localInv = readList(KEYS.inventory).filter((i) => i.id !== id);
      writeList(KEYS.inventory, localInv);
    }
    await afterDataChange();
    return;
  }
  });

  inventoryStock.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.action !== "inv-flag") return;
    const flag = input.dataset.flag;
    const id = input.dataset.id;
    if (!flag || !id) return;
    const desired = input.checked;
    void persistInvUnitFlag(id, flag, desired).then((ok) => {
      if (!ok) input.checked = !desired;
    });
  });
}

if (invStockSearch) {
  invStockSearch.addEventListener("input", () => renderInventory());
}
if (invStockFilter) {
  invStockFilter.addEventListener("change", () => renderInventory());
}

if (deviceHistorySearchBtn) {
  deviceHistorySearchBtn.addEventListener("click", () => {
    renderDeviceHistoryResults(deviceHistoryQuery?.value || "");
  });
}
if (deviceHistoryQuery) {
  deviceHistoryQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      renderDeviceHistoryResults(deviceHistoryQuery.value);
    }
  });
}

wireTechModalPanel(techWarrantyModal, techWarrantyModalBackdrop, [
  techWarrantyModalClose,
  techWarrantyModalCancel,
]);
wireTechModalPanel(techSendModal, techSendModalBackdrop, [techSendModalClose, techSendModalCancel]);
wireTechModalPanel(techExpenseModal, techExpenseModalBackdrop, [
  techExpenseModalClose,
  techExpenseModalCancel,
]);

btnTechWarranty?.addEventListener("click", () => {
  void openTechWarrantyModal();
});
btnTechStock?.addEventListener("click", () => openTechSendModal());
btnTechExpense?.addEventListener("click", () => openTechExpenseModal());
btnTechToggleCash?.addEventListener("click", () => {
  if (techCashDetails) {
    techCashDetails.open = true;
    techCashDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

document.getElementById("tab-servicio-tecnico")?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const openBtn = target.closest("[data-tech-open]");
  if (!(openBtn instanceof HTMLElement)) return;
  const kind = openBtn.dataset.techOpen;
  if (kind === "warranty") void openTechWarrantyModal();
  else if (kind === "stock") openTechSendModal();
});

const techWarrantyIncludeExpired = document.getElementById("tech-warranty-include-expired");
if (techWarrantyIncludeExpired) {
  techWarrantyIncludeExpired.addEventListener("change", () => refreshTechWarrantyPickList());
}

if (techWarrantyForm) {
  techWarrantyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saleId = techWarrantyPick?.value?.trim() || "";
    if (!saleId) {
      alert("Elegí una venta en garantía.");
      return;
    }
    try {
      await sendWarrantySaleToTech(saleId, techWarrantyNotes?.value || "");
      techWarrantyForm.reset();
      closeTechModal(techWarrantyModal);
      await afterDataChange();
      switchTab("servicio-tecnico");
    } catch (e) {
      alert(e.message || "No se pudo ingresar por garantía.");
    }
  });
}

if (techSendForm) {
  techSendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const itemId = techSendPick?.value?.trim() || "";
    if (!itemId) {
      alert("Elegí un equipo del inventario.");
      return;
    }
    try {
      await markInventorySentToTech(itemId, techSendNotes?.value || "");
      techSendForm.reset();
      closeTechModal(techSendModal);
      await afterDataChange();
    } catch (e) {
      alert(e.message || "No se pudo enviar a técnico.");
    }
  });
}

if (techExpensePick) {
  techExpensePick.addEventListener("change", () => {
    const id = techExpensePick.value?.trim();
    if (id) prefillTechExpenseForItem(id);
  });
}

if (techExpenseForm) {
  techExpenseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const itemId = techExpensePick?.value?.trim() || "";
    const amount = Number(techExpenseAmount?.value);
    const date = techExpenseDate?.value || "";
    const concept = techExpenseConcept?.value?.trim() || "";
    if (!itemId || !date || !concept || !(amount > 0)) {
      alert("Completá equipo, fecha, concepto y monto.");
      return;
    }
    try {
      await addTechRepairExpense({
        itemId,
        amount,
        date,
        concept,
        registerCash: techExpenseCash?.checked !== false,
      });
      techExpenseForm.reset();
      if (techExpenseConcept) techExpenseConcept.placeholder = "Ej: Garantía · cambio de pantalla";
      closeTechModal(techExpenseModal);
      await afterDataChange();
    } catch (e) {
      alert(e.message || "No se pudo registrar el gasto.");
    }
  });
}

if (techUnitsList) {
  techUnitsList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest("[data-tech-action]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.techAction;
    const id = btn.dataset.id;
    if (!id) return;
    if (action === "view") {
      openInvUnitModal(id);
      return;
    }
    if (action === "expense") {
      openTechExpenseModal(id);
      return;
    }
    if (action === "done") {
      const item = getInventory().find((i) => String(i.id) === String(id));
      if (!item) return;
      const label = `${item.model} · ${item.color} · ${item.storage}`;
      if (!confirm(`¿Dar de alta "${label}" y quitar de servicio técnico?`)) return;
      try {
        await releaseInventoryFromTech(id);
        await afterDataChange();
      } catch (e) {
        alert(e.message || "No se pudo actualizar el equipo.");
      }
    }
  });
}

const receivableForm = document.getElementById("receivable-form");
const receivablesBodyEl = document.getElementById("receivables-body");

if (receivableForm) {
  receivableForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const clientName = document.getElementById("recv-client")?.value?.trim() || "";
    const concept = document.getElementById("recv-concept")?.value?.trim() || "";
    const amount = numeric(document.getElementById("recv-amount")?.value, 0);
    const dueDate = document.getElementById("recv-due")?.value || "";
    const kindRaw = document.getElementById("recv-kind")?.value || "cuotas";
    const notes = document.getElementById("recv-notes")?.value?.trim() || "";
    if (!clientName || !concept || amount <= 0) {
      alert("Completá cliente, concepto y monto pendiente mayor a 0.");
      return;
    }
    const k = kindRaw === "tarjeta" || kindRaw === "otro" ? kindRaw : "cuotas";

    if (editingReceivableId) {
      if (useCloud) {
        try {
          const userId = await getUserId();
          const { error } = await supabaseClient
            .from("pending_receivables")
            .update({
              client_name: clientName,
              concept,
              amount_pending: amount,
              due_date: dueDate || null,
              kind: k,
              notes,
            })
            .eq("id", editingReceivableId)
            .eq("user_id", userId);
          if (error) throw error;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          alert(m || "Error al actualizar.");
          return;
        }
      } else {
        const list = readList(KEYS.receivables);
        const item = list.find((r) => String(r.id) === String(editingReceivableId));
        if (item) {
          item.clientName = clientName;
          item.concept = concept;
          item.amountPending = amount;
          item.dueDate = dueDate;
          item.kind = k;
          item.notes = notes;
          writeList(KEYS.receivables, list);
        }
      }
      clearRecvEdit();
      receivableForm.reset();
      closeCrudModal(receivableModal);
      await afterDataChange();
      return;
    }

    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient.from("pending_receivables").insert({
          user_id: userId,
          client_name: clientName,
          concept,
          amount_pending: amount,
          due_date: dueDate || null,
          kind: k,
          notes,
        });
        if (error) throw error;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        alert(
          /schema cache|could not find/i.test(m)
            ? "Falta la tabla pending_receivables en Supabase. Ejecutá CRM/supabase/migration_pending_receivables.sql\n\n" + m
            : m || "Error al guardar."
        );
        return;
      }
    } else {
      const list = readList(KEYS.receivables);
      list.unshift({
        id: crypto.randomUUID(),
        clientName,
        concept,
        amountPending: amount,
        dueDate,
        kind: k,
        notes,
        createdAt: new Date().toISOString(),
      });
      writeList(KEYS.receivables, list);
    }
    receivableForm.reset();
    closeCrudModal(receivableModal);
    await afterDataChange();
  });
}

if (receivablesBodyEl) {
  receivablesBodyEl.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const id = t.dataset.id;
    if (!id) return;
    const row = getReceivables().find((r) => String(r.id) === id);
    if (!row) return;

    if (t.classList.contains("recv-edit-btn")) {
      beginEditReceivable(id);
      return;
    }

    if (t.classList.contains("recv-del-btn")) {
      if (!confirm("¿Eliminar este pendiente de la lista?")) return;
      if (useCloud) {
        try {
          const userId = await getUserId();
          const { error } = await supabaseClient
            .from("pending_receivables")
            .delete()
            .eq("id", id)
            .eq("user_id", userId);
          if (error) throw error;
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
          return;
        }
      } else {
        writeList(
          KEYS.receivables,
          readList(KEYS.receivables).filter((r) => String(r.id) !== id)
        );
      }
      await afterDataChange();
      return;
    }

    if (t.classList.contains("recv-pay-btn")) {
      const def = String(numeric(row.amountPending, 0));
      const raw = prompt(`Monto cobrado ahora (USD). Pendiente actual: ${def}`, def);
      if (raw == null) return;
      const paid = numeric(String(raw).replace(",", "."), NaN);
      if (!Number.isFinite(paid) || paid <= 0) {
        alert("Ingresá un monto válido.");
        return;
      }
      if (window.__businessExtras?.promptReceivablePayment) {
        window.__businessExtras.promptReceivablePayment(row, paid);
        return;
      }
      const next = Math.max(0, numeric(row.amountPending, 0) - paid);
      if (useCloud) {
        try {
          const userId = await getUserId();
          if (next <= 0) {
            const { error } = await supabaseClient
              .from("pending_receivables")
              .delete()
              .eq("id", id)
              .eq("user_id", userId);
            if (error) throw error;
          } else {
            const { error } = await supabaseClient
              .from("pending_receivables")
              .update({ amount_pending: next })
              .eq("id", id)
              .eq("user_id", userId);
            if (error) throw error;
          }
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
          return;
        }
      } else {
        const list = readList(KEYS.receivables);
        const item = list.find((r) => String(r.id) === id);
        if (!item) return;
        if (next <= 0) {
          writeList(
            KEYS.receivables,
            list.filter((r) => String(r.id) !== id)
          );
        } else {
          item.amountPending = next;
          writeList(KEYS.receivables, list);
        }
      }
      await afterDataChange();
    }
  });
}

function renderCuotasSimulator() {
  const input = document.getElementById("cuotas-sim-amount");
  const empty = document.getElementById("cuotas-sim-empty");
  const grid = document.getElementById("cuotas-sim-results");
  const listaBox = document.getElementById("cuotas-sim-lista-box");
  const listaVal = document.getElementById("cuotas-sim-lista-val");
  const contadoVal = document.getElementById("cuotas-sim-contado-val");
  if (!input || !empty || !grid) return;

  const contadoArs = parseArsInput(input.value);
  const listaArs = listaArsFromContado(contadoArs);
  const plans = computeCuotaSimPlans(listaArs);
  const hasAmount = contadoArs > 0;

  empty.hidden = hasAmount;
  grid.hidden = !hasAmount;
  if (listaBox) listaBox.hidden = !hasAmount;
  if (contadoVal) contadoVal.textContent = hasAmount ? currencyArs(contadoArs) : "—";
  if (listaVal) listaVal.textContent = hasAmount ? currencyArs(listaArs) : "—";

  for (const plan of plans) {
    const monthlyEl = document.getElementById(`cuotas-sim-${plan.n}-monthly`);
    const totalEl = document.getElementById(`cuotas-sim-${plan.n}-total`);
    if (monthlyEl) monthlyEl.textContent = hasAmount ? currencyArs(plan.monthly) : "—";
    if (totalEl) totalEl.textContent = hasAmount ? currencyArs(plan.total) : "—";
  }
}

const cuotasSimAmountInput = document.getElementById("cuotas-sim-amount");
if (cuotasSimAmountInput) {
  cuotasSimAmountInput.addEventListener("input", renderCuotasSimulator);
  cuotasSimAmountInput.addEventListener("change", renderCuotasSimulator);
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

const configSubnavEl = document.querySelector("#tab-configuraciones .config-subnav");
if (configSubnavEl) {
  configSubnavEl.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest(".config-subnav-tab");
    if (!btn || !configSubnavEl.contains(btn)) return;
    const id = btn.dataset.configSubpanel;
    if (!id) return;
    switchConfigSubpanel(id);
  });
}

const initialTab =
  document.querySelector(".sidebar-nav .tab-btn.active")?.dataset.tab || "resumen";
updateMainHeader(initialTab);
syncAppDock(initialTab);
if (initialTab === "configuraciones") {
  switchConfigSubpanel(getConfigSubpanel());
}

function tickHeaderClock() {
  const el = document.getElementById("header-clock");
  if (!el) return;
  el.textContent = new Intl.DateTimeFormat("es-AR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}
setInterval(tickHeaderClock, 1000);
tickHeaderClock();

const btnHeaderRefresh = document.getElementById("btn-header-refresh");
if (btnHeaderRefresh) {
  btnHeaderRefresh.addEventListener("click", () => {
    renderAll();
  });
}

if (warrantyBody) {
  warrantyBody.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const histBtn = target.closest(".warranty-history-btn");
    if (histBtn instanceof HTMLElement) {
      openDeviceHistoryForIdentity(histBtn.dataset.serial || "", histBtn.dataset.imei || "");
      return;
    }
    const editBtn = target.closest(".warranty-edit-sale-btn");
    if (editBtn instanceof HTMLElement && editBtn.dataset.id) {
      switchTab("ventas");
      openSaleModalForEdit(editBtn.dataset.id);
      return;
    }
    const techBtn = target.closest(".warranty-tech-btn");
    if (techBtn instanceof HTMLElement && techBtn.dataset.id && !techBtn.disabled) {
      const notes = window.prompt("Motivo o falla (opcional):", "") ?? "";
      void (async () => {
        try {
          await sendWarrantySaleToTech(techBtn.dataset.id, notes);
          await afterDataChange();
          switchTab("servicio-tecnico");
        } catch (e) {
          alert(e.message || "No se pudo enviar a taller.");
        }
      })();
    }
  });
}

const dashboardMonthEl = document.getElementById("dashboard-month");
if (dashboardMonthEl) {
  dashboardMonthEl.addEventListener("change", () => {
    persistDashboardMonth(dashboardMonthEl.value);
    updatePeriodBarNote();
    renderAll();
  });
}

if (btnSellerCancelEdit) {
  btnSellerCancelEdit.addEventListener("click", () => clearSellerEdit());
}

if (sellerForm) {
  sellerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = sellerName?.value?.trim() || "";
    const pctRaw = sellerCommissionPct ? Number(sellerCommissionPct.value) : 0;
    const active = sellerActive ? sellerActive.checked : true;
    if (!name) {
      alert("Indicá el nombre del vendedor.");
      return;
    }
    if (!Number.isFinite(pctRaw) || pctRaw < 0 || pctRaw > 100) {
      alert("La comisión debe estar entre 0 y 100.");
      return;
    }

    if (editingSellerId) {
      if (useCloud) {
        try {
          const userId = await getUserId();
          const { error } = await supabaseClient
            .from("salespeople")
            .update({
              name,
              commission_pct: pctRaw,
              active,
            })
            .eq("id", editingSellerId)
            .eq("user_id", userId);
          if (error) throw error;
        } catch (e) {
          alertSellerDbError(e);
          return;
        }
      } else {
        const list = readList(KEYS.sellers);
        const idx = list.findIndex((x) => String(x.id) === String(editingSellerId));
        if (idx >= 0) {
          list[idx] = { ...list[idx], name, commissionPct: pctRaw, active };
          writeList(KEYS.sellers, list);
        }
      }
      clearSellerEdit();
      await afterDataChange();
      return;
    }

    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient.from("salespeople").insert({
          user_id: userId,
          name,
          commission_pct: pctRaw,
          active,
        });
        if (error) throw error;
      } catch (e) {
        alertSellerDbError(e);
        return;
      }
    } else {
      const list = readList(KEYS.sellers);
      list.push({
        id: crypto.randomUUID(),
        name,
        commissionPct: pctRaw,
        active,
      });
      writeList(KEYS.sellers, list);
    }
    clearSellerEdit();
    await afterDataChange();
  });
}

if (sellersBody) {
  sellersBody.addEventListener("click", async (event) => {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;
    const editBtn = t.closest(".edit-seller-btn");
    if (editBtn) {
      const id = editBtn.dataset.id;
      if (!id) return;
      const sp = getSellers().find((x) => String(x.id) === String(id));
      if (!sp) return;
      editingSellerId = sp.id;
      if (sellerEditHintEl) sellerEditHintEl.hidden = false;
      if (sellerFormSubmitBtn) sellerFormSubmitBtn.textContent = "Guardar cambios";
      if (btnSellerCancelEdit) btnSellerCancelEdit.hidden = false;
      if (sellerName) sellerName.value = sp.name;
      if (sellerCommissionPct) sellerCommissionPct.value = String(numeric(sp.commissionPct, 0));
      if (sellerActive) sellerActive.checked = sp.active !== false;
      if (sellerName) sellerName.focus();
      return;
    }
    if (!t.classList.contains("delete-btn") || t.dataset.type !== "seller") return;
    const id = t.dataset.id;
    if (!id) return;
    if (!confirm("¿Eliminar este vendedor? Las ventas pasadas conservan la comisión registrada; se quitará la referencia al vendedor.")) return;
    if (useCloud) {
      try {
        const userId = await getUserId();
        const { error } = await supabaseClient.from("salespeople").delete().eq("id", id).eq("user_id", userId);
        if (error) throw error;
      } catch (e) {
        alertSellerDbError(e);
        return;
      }
    } else {
      const list = readList(KEYS.sellers).filter((x) => String(x.id) !== String(id));
      writeList(KEYS.sellers, list);
      const sales = readList(KEYS.sales);
      let changed = false;
      for (const s of sales) {
        if (String(s.sellerId) === String(id)) {
          s.sellerId = null;
          changed = true;
        }
      }
      if (changed) writeList(KEYS.sales, sales);
    }
    if (String(editingSellerId) === String(id)) clearSellerEdit();
    await afterDataChange();
  });
}

const btnSaveGoals = document.getElementById("btn-save-goals");
const storeCostsList = document.getElementById("store-costs-list");
storeCostsList?.addEventListener("input", updateStoreCostsTotal);
storeCostsList?.addEventListener("click", (event) => {
  const removeBtn = event.target.closest(".store-cost-remove");
  if (!removeBtn) return;
  removeBtn.closest(".store-cost-row")?.remove();
  updateStoreCostsTotal();
});
document.getElementById("btn-add-store-cost")?.addEventListener("click", () => {
  const list = document.getElementById("store-costs-list");
  if (!list) return;
  const current = readStoreCostsFromForm();
  current.push({ id: crypto.randomUUID(), name: "", amount: 0 });
  renderStoreCostRows(current);
  const lastName = list.querySelector(".store-cost-row:last-child [data-cost-name]");
  lastName?.focus();
});
if (btnSaveGoals) {
  btnSaveGoals.addEventListener("click", async () => {
    const income = Number(document.getElementById("goal-income")?.value);
    const profit = Number(document.getElementById("goal-profit")?.value);
    const units = Number(document.getElementById("goal-units")?.value);
    let r = Number(document.getElementById("split-reserve-pct")?.value);
    let m = Number(document.getElementById("split-middle-pct")?.value);
    let p = Number(document.getElementById("split-partners-pct")?.value);
    if (!Number.isFinite(r) || r < 0) r = DEFAULT_GOALS.reservePct;
    if (!Number.isFinite(m) || m < 0) m = DEFAULT_GOALS.middlePct;
    if (!Number.isFinite(p) || p < 0) p = DEFAULT_GOALS.partnersPct;
    const sum = r + m + p;
    if (sum <= 0) {
      alert("Los porcentajes de reparto deben sumar más de 0.");
      return;
    }
    if (Math.abs(sum - 100) > 0.001) {
      r = (r / sum) * 100;
      m = (m / sum) * 100;
      p = (p / sum) * 100;
    }
    const dolarRaw = Number(document.getElementById("goal-dolar-blue")?.value);
    const dolarBlueArsPerUsd =
      Number.isFinite(dolarRaw) && dolarRaw > 0 ? Math.round(dolarRaw * 100) / 100 : 0;

    writeGoals({
      incomeMonthlyUsd: Number.isFinite(income) && income >= 0 ? income : 0,
      profitMonthlyUsd: Number.isFinite(profit) && profit >= 0 ? profit : 0,
      unitsMonthly: Number.isFinite(units) && units >= 0 ? Math.floor(units) : 0,
      dolarBlueArsPerUsd,
      reservePct: Math.round(r * 100) / 100,
      middlePct: Math.round(m * 100) / 100,
      partnersPct: Math.round(p * 100) / 100,
      storeCosts: readStoreCostsFromForm(),
    });
    const sr = document.getElementById("split-reserve-pct");
    const sm = document.getElementById("split-middle-pct");
    const sp = document.getElementById("split-partners-pct");
    const dbIn = document.getElementById("goal-dolar-blue");
    const g = readGoals();
    if (sr) sr.value = String(g.reservePct);
    if (sm) sm.value = String(g.middlePct);
    if (sp) sp.value = String(g.partnersPct);
    if (dbIn) dbIn.value = g.dolarBlueArsPerUsd > 0 ? String(g.dolarBlueArsPerUsd) : "";
    if (useCloud) {
      await saveCrmSettingsDolarToCloud(dolarBlueArsPerUsd);
      await cloudRecomputeAllInventoryArsForUser();
      await refreshCloud();
      mirrorCloudCachesToLocal();
    }
    renderGoalsProgress();
    renderDashboard();
    renderInventory();
    btnSaveGoals.textContent = "Guardado";
    setTimeout(() => {
      btnSaveGoals.textContent = "Guardar metas";
    }, 1600);
  });
}

const btnUserMeta = document.getElementById("btn-user-meta");
if (btnUserMeta) {
  btnUserMeta.addEventListener("click", async () => {
    const id = btnUserMeta.dataset.userId?.trim();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      const prev = btnUserMeta.title;
      btnUserMeta.title = "Copiado al portapapeles";
      setTimeout(() => {
        btnUserMeta.title = prev;
      }, 2000);
    } catch (_) {
      alert(id);
    }
  });
}

if (btnLogoutSupabase) {
  btnLogoutSupabase.addEventListener("click", async () => {
    if (!supabaseClient) return;
    unsubscribeCloudRealtime();
    await supabaseClient.auth.signOut();
    useCloud = false;
    cacheCrmSettings = null;
    setAuthError("");
    setAuthStatus("Sesión cerrada. Iniciá de nuevo.");
    showAuthGate();
    prefillAuthEmail();
    renderAll();
    updateConnectionUI();
    await refreshCloudUserDisplay();
  });
}

const authLoginForm = document.getElementById("auth-login-form");
const authAnonBtn = document.getElementById("auth-anon-btn");
const authLocalBtn = document.getElementById("auth-local-btn");

if (authLoginForm) {
  authLoginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setAuthError("");
    const email = document.getElementById("auth-email")?.value?.trim() || "";
    const password = document.getElementById("auth-password")?.value || "";
    if (!email || !password || !supabaseClient) return;
    setAuthStatus("Entrando…");
    cloudConnecting = true;
    updateConnectionUI();
    try {
      const out = await signInWithPasswordFlow(email, password);
      if (!out.session) {
        setAuthError(formatAuthError(out.error));
        setAuthStatus("");
        return;
      }
      hideAuthGate();
      setAuthStatus("");
      setAuthError("");
      try {
        await loadCloudDataWithCurrentSession();
      } catch (loadErr) {
        console.error(loadErr);
        const msg =
          loadErr instanceof Error ? loadErr.message : String(loadErr);
        alert(msg);
      }
      renderAll();
    } catch (err) {
      console.error(err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      cloudConnecting = false;
      updateConnectionUI();
      await refreshCloudUserDisplay();
    }
  });
}

if (authAnonBtn) {
  authAnonBtn.addEventListener("click", async () => {
    setAuthError("");
    if (!supabaseClient) return;
    setAuthStatus("Creando sesión anónima…");
    cloudConnecting = true;
    updateConnectionUI();
    try {
      const out = await signInAnonymousViaRest();
      if (!out.session) {
        setAuthError(formatAuthError(out.error));
        setAuthStatus("");
        return;
      }
      hideAuthGate();
      setAuthStatus("");
      try {
        await loadCloudDataWithCurrentSession();
      } catch (loadErr) {
        console.error(loadErr);
        const msg =
          loadErr instanceof Error ? loadErr.message : String(loadErr);
        alert(msg);
      }
      renderAll();
    } catch (err) {
      console.error(err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      cloudConnecting = false;
      updateConnectionUI();
      await refreshCloudUserDisplay();
    }
  });
}

if (authLocalBtn) {
  authLocalBtn.addEventListener("click", () => {
    setAuthError("");
    setAuthStatus("");
    hideAuthGate();
    useCloud = false;
    cacheCrmSettings = null;
    renderAll();
    updateConnectionUI();
  });
}

let appInitStarted = false;

async function initApp() {
  if (isStaffMode()) {
    document.body.classList.add("app-staff-mode");
    if (isStaffPinRequired() && !hasStaffUnlock()) {
      bindStaffGate();
      if (appShell) appShell.hidden = true;
      showStaffGate();
      return;
    }
    hideStaffGate();
    applyStaffUi();
  }
  if (appInitStarted) return;
  appInitStarted = true;

  useCloud = false;
  cloudConnecting = false;
  loginPanelVisible = false;
  hideAuthGate();
  if (appShell) appShell.hidden = false;
  setTodayDefaults();
  syncCashEgresoKindUi();
  renderAll();

  if (!isCloudConfigured()) {
    updateConnectionUI();
    return;
  }

  const createClient = getCreateClient();
  if (!createClient) {
    alert("No se pudo cargar la librería de Supabase. Revisá la conexión a internet.");
    updateConnectionUI();
    return;
  }

  supabaseClient = createClient(window.APP_SUPABASE_URL, window.APP_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      storage: window.localStorage,
      storageKey: "go-apple-crm-supabase-auth",
      autoRefreshToken: true,
      detectSessionInUrl: false,
      lock: async (_name, _acquireTimeout, fn) => fn(),
    },
  });

  cloudConnecting = true;
  updateConnectionUI();
  try {
    const entered = await tryEnterCloudFromStoredUrlOrConfig();
    if (!entered) {
      showAuthGate();
      prefillAuthEmail();
      setAuthStatus("Iniciá sesión con tu usuario de Supabase.");
    }
  } catch (e) {
    console.warn("No se pudo entrar a Supabase al iniciar:", e);
    useCloud = false;
    cacheCrmSettings = null;
    unsubscribeCloudRealtime();
    showAuthGate();
    prefillAuthEmail();
    setAuthError(e instanceof Error ? formatAuthError(e) : String(e));
  } finally {
    cloudConnecting = false;
  }

  renderAll();
  updateConnectionUI();
  await refreshCloudUserDisplay();
}

initUiThemeControls();
bindAppDock();
setupPipelineBoardInteractions();
setupCreativoRefFilePreview();
hydrateCreativosConfigForm();
updateCreativosOpenAIStatus();

/* ── Creativos event listeners ── */
{
  const btnNew = document.getElementById("btn-creativos-new");
  if (btnNew) btnNew.addEventListener("click", () => openCreativosModal(null));

  const btnSync = document.getElementById("btn-creativos-sync-notion");
  if (btnSync) btnSync.addEventListener("click", syncNotionCreativos);

  const btnSyncInstagram = document.getElementById("btn-creativos-sync-instagram");
  if (btnSyncInstagram) btnSyncInstagram.addEventListener("click", syncInstagramViralesCreativos);

  const btnImportClaude = document.getElementById("btn-creativos-import-claude");
  if (btnImportClaude) btnImportClaude.addEventListener("click", openImportClaudeModal);
  const btnImportRun = document.getElementById("btn-creativos-import-run");
  if (btnImportRun) btnImportRun.addEventListener("click", runImportFromClaude);
  const importModalClose = document.getElementById("creativos-import-modal-close");
  if (importModalClose) importModalClose.addEventListener("click", closeImportClaudeModal);
  const importModalCancel = document.getElementById("creativos-import-cancel");
  if (importModalCancel) importModalCancel.addEventListener("click", closeImportClaudeModal);
  const importBackdrop = document.getElementById("creativos-import-modal-backdrop");
  if (importBackdrop) importBackdrop.addEventListener("click", closeImportClaudeModal);

  const btnDlPreviews = document.getElementById("btn-creativos-download-previews");
  if (btnDlPreviews) btnDlPreviews.addEventListener("click", async () => {
    mergeCreativosConfigFromGlobals();
    const cfg = getCreativosConfig();
    if (!cfg.rapidapiKey) { alert("Configurá la RapidAPI Key en Configuraciones → Creativos / IA."); return; }
    const list = getCreativos();
    const need = list.filter((c) => c.postUrl && (!c.mediaUrls || c.mediaUrls.length === 0 || (!c.videoUrl && c.contentType !== "carousel")));
    if (need.length === 0) { alert("Todos los posts ya tienen preview."); return; }
    const bar = document.getElementById("creativos-progress");
    if (bar) { bar.hidden = false; bar.textContent = `Descargando previews…`; }
    await downloadRefPreviews(need, cfg, bar);
    if (bar) { bar.textContent = "Previews descargados."; setTimeout(() => { bar.hidden = true; }, 3000); }
  });

  const modalClose = document.getElementById("creativos-modal-close");
  if (modalClose) modalClose.addEventListener("click", closeCreativosModal);
  const modalCancel = document.getElementById("creativos-modal-cancel");
  if (modalCancel) modalCancel.addEventListener("click", closeCreativosModal);
  const backdrop = document.getElementById("creativos-modal-backdrop");
  if (backdrop) backdrop.addEventListener("click", closeCreativosModal);

  const form = document.getElementById("creativos-form");
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); saveCreativoFromForm(); });

  // Sub-tab switching

  // Referencias board
  const boardRef = document.getElementById("creativos-board-ref");
  if (boardRef) {
    boardRef.addEventListener("click", (e) => {
      const groupHeader = e.target.closest(".competitor-group__header");
      if (groupHeader) {
        const group = groupHeader.closest(".competitor-group");
        if (group) group.classList.toggle("collapsed");
        return;
      }
      const processBtn = e.target.closest(".ref-card__process-btn");
      if (processBtn) { e.stopPropagation(); processSingleCreativo(processBtn.dataset.id); return; }
      const delBtn = e.target.closest(".ref-card__del-btn");
      if (delBtn) { e.stopPropagation(); deleteCreativo(delBtn.dataset.id); return; }
      const lbTrigger = e.target.closest(".ref-card__open-lb");
      if (lbTrigger) { openLightbox(lbTrigger.dataset.id); return; }
      if (e.target.closest("a")) return;
    });
  }


  document.querySelectorAll(".creativos-subtab").forEach((btn) => {
    btn.addEventListener("click", () => switchCreativosSubtab(btn.dataset.subtab));
  });

  const ideasContextEl = document.getElementById("creativos-ideas-context");
  try {
    const savedCtx = localStorage.getItem("creativos_last_ideas_context");
    if (savedCtx && ideasContextEl && !ideasContextEl.value) ideasContextEl.value = savedCtx;
  } catch (_) {}
  document.getElementById("btn-generate-ideas")?.addEventListener("click", runGenerateIdeasFromContext);

  initCreativosKanbanDragDrop();

  const workspace = document.getElementById("creativos-workspace");
  if (workspace) {
    workspace.addEventListener("click", (e) => {
      const editBtn = e.target.closest(".creativos-edit-btn");
      if (editBtn) { openCreativosModal(editBtn.dataset.id); return; }
      const delBtn = e.target.closest(".creativos-del-btn");
      if (delBtn) { deleteCreativo(delBtn.dataset.id); return; }
      const copyBtn = e.target.closest(".creativos-copy-btn");
      if (copyBtn) {
        const c = getCreativos().find((x) => x.id === copyBtn.dataset.id);
        if (c?.copy) { navigator.clipboard.writeText(c.copy).then(() => alert("Copy copiado al portapapeles.")); }
        return;
      }
      const descBtn = e.target.closest(".creativos-desc-btn");
      if (descBtn) {
        const c = getCreativos().find((x) => x.id === descBtn.dataset.id);
        if (c?.description) { navigator.clipboard.writeText(c.description).then(() => alert("Descripción copiada al portapapeles.")); }
        return;
      }
      const dlBtn = e.target.closest(".creativos-dl-btn");
      if (dlBtn) { downloadCreativoImage(dlBtn.dataset.id); return; }
      const carouselBtn = e.target.closest(".creativos-card__carousel-btn");
      if (carouselBtn) {
        const cId = carouselBtn.dataset.id;
        const dir = Number(carouselBtn.dataset.dir);
        const c = getCreativos().find((x) => x.id === cId);
        const imgs = c?.mediaUrls;
        if (!c || !imgs || imgs.length <= 1) return;
        const wrap = carouselBtn.closest(".creativos-card__carousel");
        const img = wrap?.querySelector(".creativos-card__carousel-img");
        const counter = wrap?.querySelector(".creativos-card__carousel-counter");
        if (!img) return;
        let idx = Number(img.dataset.index || 0) + dir;
        if (idx < 0) idx = imgs.length - 1;
        if (idx >= imgs.length) idx = 0;
        img.src = imgs[idx];
        img.dataset.index = idx;
        if (counter) counter.textContent = `${idx + 1}/${imgs.length}`;
        return;
      }
      const stepAction = e.target.closest(".gen-step__action");
      if (stepAction) {
        const action = stepAction.dataset.action;
        const id = stepAction.dataset.id;
        if (action === "regen-copy") { regenCopyOnly(id); }
        else if (action === "regen-img") { regenImagesOnly(id); }
        return;
      }
      const genCopyBtn = e.target.closest(".kanban-card__gen-copy");
      if (genCopyBtn) { processCopyOnly(genCopyBtn.dataset.id); return; }
      const kanbanDel = e.target.closest(".kanban-card__del");
      if (kanbanDel) { deleteCreativo(kanbanDel.dataset.id); return; }
      if (e.target.closest("a") || e.target.closest("button")) return;
      const card = e.target.closest(".kanban-card") || e.target.closest(".gen-card");
      if (card) { openLightboxGen(card.dataset.id); return; }
    });
  }

  const genCopy = document.getElementById("btn-creativo-gen-copy");
  if (genCopy) genCopy.addEventListener("click", generateCreativoCopy);
  const genImg = document.getElementById("btn-creativo-gen-image");
  if (genImg) genImg.addEventListener("click", generateCreativoImage);

  const saveCfg = document.getElementById("btn-save-creativos-config");
  if (saveCfg) saveCfg.addEventListener("click", saveCreativosConfigFromForm);

  const cp1 = document.getElementById("config-brand-color-picker");
  const ct1 = document.getElementById("config-brand-color");
  if (cp1 && ct1) {
    cp1.addEventListener("input", () => { ct1.value = cp1.value; });
    ct1.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(ct1.value)) cp1.value = ct1.value; });
  }
  const cp2 = document.getElementById("config-brand-color2-picker");
  const ct2 = document.getElementById("config-brand-color2");
  if (cp2 && ct2) {
    cp2.addEventListener("input", () => { ct2.value = cp2.value; });
    ct2.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(ct2.value)) cp2.value = ct2.value; });
  }

  const searchRef = document.getElementById("creativos-filter-q");
  if (searchRef) searchRef.addEventListener("input", renderCreativos);
  const searchGen = document.getElementById("creativos-search-gen");
  if (searchGen) searchGen.addEventListener("input", renderCreativos);
  const filterGen = document.getElementById("creativos-filter-gen");
  if (filterGen) filterGen.addEventListener("change", renderCreativos);
}

window.__crm = {
  KEYS,
  get useCloud() {
    return useCloud;
  },
  get supabaseClient() {
    return supabaseClient;
  },
  getUserId,
  readList,
  writeList,
  afterDataChange,
  getSales,
  getCash,
  getInventory,
  getReceivables,
  getDashboardMonthKey,
  salesForMonthKey,
  recordInMonth,
  warrantyDaysRemaining,
  saleHasDeviceIdentity,
  resolveLineDeviceIdentity,
  resolveSaleDeviceIdentity,
  computeSaleCommission,
  syncCommissionCashFromSale,
  populateCashRepartoDestSelect,
  repartoDestToEgresoKind,
  cashRepartoDestOf,
  getSellerNameById,
  escapeHtml,
  currency,
  numeric,
  navigateToAlert,
  renderAll,
  writeViewFilters,
  switchConfigSubpanel,
  openSaleModalForEdit,
};

initApp().catch((err) => {
  console.error(err);
  alert(err.message || "Error al iniciar.");
});
