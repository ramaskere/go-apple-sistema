/**
 * Cierre semanal de caja, alertas, validaciones de venta, comisiones pagadas,
 * cobros de deudores con destino, exportaciones y ficha de cliente.
 * Requiere window.__crm (expuesto desde app.js).
 */
(function initBusinessExtras() {
  const CRM_KEY_WEEK_CLOSES = "go_apple_cash_week_closes";
  let cacheWeekCloses = [];

  function crm() {
    return window.__crm || null;
  }

  function ymd(d) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  /** Semana comercial: domingo → sábado (cierre el sábado). */
  function getWeekBoundsForDate(dateLike) {
    const d = dateLike instanceof Date ? new Date(dateLike) : new Date(String(dateLike || ""));
    if (Number.isNaN(d.getTime())) {
      const now = new Date();
      return getWeekBoundsForDate(now);
    }
    d.setHours(12, 0, 0, 0);
    const day = d.getDay();
    const start = new Date(d);
    start.setDate(d.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { weekStart: ymd(start), weekEnd: ymd(end) };
  }

  function getCurrentWeekBounds() {
    return getWeekBoundsForDate(new Date());
  }

  function formatWeekLabel(bounds) {
    const fmt = (s) => {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
    };
    return `${fmt(bounds.weekStart)} – ${fmt(bounds.weekEnd)} (cierra sábado)`;
  }

  function getWeekCloses() {
    const c = crm();
    if (c?.useCloud && cacheWeekCloses.length) return cacheWeekCloses;
    try {
      const raw = localStorage.getItem(CRM_KEY_WEEK_CLOSES);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function writeWeekClosesLocal(list) {
    try {
      localStorage.setItem(CRM_KEY_WEEK_CLOSES, JSON.stringify(list));
    } catch {
      /* — */
    }
    cacheWeekCloses = list;
  }

  function weekCloseFromRow(row) {
    return {
      id: row.id,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      closeDate: row.close_date,
      expectedCash: Number(row.expected_cash ?? 0),
      expectedTransfer: Number(row.expected_transfer ?? 0),
      expectedCard: Number(row.expected_card ?? 0),
      expectedOther: Number(row.expected_other ?? 0),
      expectedTotal: Number(row.expected_total ?? 0),
      countedCash: Number(row.counted_cash ?? 0),
      countedTransfer: Number(row.counted_transfer ?? 0),
      countedCard: Number(row.counted_card ?? 0),
      cashDifference: Number(row.cash_difference ?? 0),
      notes: row.notes || "",
    };
  }

  function isDateInRange(dateStr, startYmd, endYmd) {
    if (!dateStr || !startYmd || !endYmd) return false;
    return String(dateStr) >= startYmd && String(dateStr) <= endYmd;
  }

  function salePaymentBreakdown(s, c) {
    const cash = c.numeric(s.paymentCash ?? s.payment_cash, 0);
    const transfer = c.numeric(s.paymentTransfer ?? s.payment_transfer, 0);
    const card = c.numeric(s.paymentCard ?? s.payment_card, 0);
    const other = c.numeric(s.paymentOther ?? s.payment_other, 0);
    const paid = cash + transfer + card + other;
    const total = c.numeric(s.saleTotal ?? s.sale_total, 0);
    if (paid > 0.02) {
      return { cash, transfer, card, other };
    }
    if (total > 0) {
      return { cash: total, transfer: 0, card: 0, other: 0 };
    }
    return { cash: 0, transfer: 0, card: 0, other: 0 };
  }

  function computeWeekCashExpected(bounds) {
    const c = crm();
    if (!c) return null;
    const sales = c.getSales();
    const cash = c.getCash();
    let expectedCash = 0;
    let expectedTransfer = 0;
    let expectedCard = 0;
    let expectedOther = 0;
    let cashIn = 0;
    let cashOut = 0;

    for (const s of sales) {
      if (!isDateInRange(s.date, bounds.weekStart, bounds.weekEnd)) continue;
      const p = salePaymentBreakdown(s, c);
      expectedCash += p.cash;
      expectedTransfer += p.transfer;
      expectedCard += p.card;
      expectedOther += p.other;
    }
    for (const row of cash) {
      if (!isDateInRange(row.date, bounds.weekStart, bounds.weekEnd)) continue;
      const amt = c.numeric(row.amount, 0);
      if (row.type === "ingreso") cashIn += amt;
      else cashOut += amt;
    }
    const expectedTotal =
      expectedCash + expectedTransfer + expectedCard + expectedOther + cashIn - cashOut;
    return {
      expectedCash,
      expectedTransfer,
      expectedCard,
      expectedOther,
      cashMovementsIn: cashIn,
      cashMovementsOut: cashOut,
      expectedTotal,
    };
  }

  function findWeekClose(bounds) {
    return getWeekCloses().find(
      (w) => w.weekStart === bounds.weekStart && w.weekEnd === bounds.weekEnd
    );
  }

  async function saveWeekClose(payload) {
    const c = crm();
    if (!c) return;
    if (c.useCloud && c.supabaseClient) {
      const userId = await c.getUserId();
      const { data, error } = await c.supabaseClient
        .from("cash_week_closes")
        .upsert({ ...payload, user_id: userId }, { onConflict: "user_id,week_start" })
        .select("*")
        .single();
      if (error) {
        if (/cash_week_closes|schema cache/i.test(error.message || "")) {
          throw new Error(
            "Falta la tabla cash_week_closes. Ejecutá CRM/supabase/migration_cash_week_closes.sql en Supabase."
          );
        }
        throw error;
      }
      const list = getWeekCloses().filter((w) => w.weekStart !== payload.week_start);
      list.unshift(weekCloseFromRow(data));
      writeWeekClosesLocal(list);
      return;
    }
    const list = getWeekCloses().filter((w) => w.weekStart !== payload.week_start);
    list.unshift({
      id: crypto.randomUUID(),
      weekStart: payload.week_start,
      weekEnd: payload.week_end,
      closeDate: payload.close_date,
      expectedCash: payload.expected_cash,
      expectedTransfer: payload.expected_transfer,
      expectedCard: payload.expected_card,
      expectedOther: payload.expected_other,
      expectedTotal: payload.expected_total,
      countedCash: payload.counted_cash,
      countedTransfer: payload.counted_transfer,
      countedCard: payload.counted_card,
      cashDifference: payload.cash_difference,
      notes: payload.notes || "",
    });
    writeWeekClosesLocal(list);
  }

  function renderWeeklyCashClose() {
    const wrap = document.getElementById("cash-week-close-panel");
    if (!wrap) return;
    const c = crm();
    if (!c) return;
    const bounds = getCurrentWeekBounds();
    const exp = computeWeekCashExpected(bounds);
    const existing = findWeekClose(bounds);
    const diff = existing
      ? existing.cashDifference
      : exp
        ? c.numeric(document.getElementById("week-close-counted-cash")?.value, exp.expectedCash) -
          exp.expectedCash
        : 0;

    document.getElementById("week-close-label").textContent = formatWeekLabel(bounds);
    const summaryEl = document.getElementById("week-close-summary");
    if (summaryEl && exp) {
      const statusTxt = existing ? "cerrada" : "pendiente";
      summaryEl.textContent = `${formatWeekLabel(bounds)} · Esperado ${c.currency(exp.expectedTotal)} · ${statusTxt}`;
    }
    if (exp) {
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = c.currency(val);
      };
      set("week-exp-cash", exp.expectedCash);
      set("week-exp-transfer", exp.expectedTransfer);
      set("week-exp-card", exp.expectedCard);
      set("week-exp-other", exp.expectedOther);
      set("week-exp-caja-in", exp.cashMovementsIn);
      set("week-exp-caja-out", exp.cashMovementsOut);
      set("week-exp-total", exp.expectedTotal);
    }
    const countedCash = document.getElementById("week-close-counted-cash");
    const countedTransfer = document.getElementById("week-close-counted-transfer");
    const countedCard = document.getElementById("week-close-counted-card");
    const notesEl = document.getElementById("week-close-notes");
    const closeDateEl = document.getElementById("week-close-date");
    if (existing) {
      if (countedCash) countedCash.value = String(existing.countedCash);
      if (countedTransfer) countedTransfer.value = String(existing.countedTransfer);
      if (countedCard) countedCard.value = String(existing.countedCard);
      if (notesEl) notesEl.value = existing.notes || "";
      if (closeDateEl) closeDateEl.value = existing.closeDate || bounds.weekEnd;
    } else {
      if (closeDateEl && !closeDateEl.value) closeDateEl.value = bounds.weekEnd;
      if (countedCash && exp && !countedCash.value) countedCash.value = String(exp.expectedCash);
    }
    const diffEl = document.getElementById("week-close-diff");
    if (diffEl && exp) {
      const counted = c.numeric(countedCash?.value, 0);
      const d = counted - exp.expectedCash;
      diffEl.textContent = c.currency(d);
      diffEl.classList.remove("week-close-diff--bad", "week-close-diff--ok");
      if (Math.abs(d) > 0.01) diffEl.classList.add("week-close-diff--bad");
      else diffEl.classList.add("week-close-diff--ok");
    }
    const statusEl = document.getElementById("week-close-status");
    if (statusEl) {
      statusEl.className = existing
        ? "week-close-status week-close-status--closed"
        : "week-close-status week-close-status--open";
      statusEl.textContent = existing ? "Cerrada" : "Pendiente";
    }
    wrap.classList.toggle("week-close-compact--closed", Boolean(existing));

    const histBody = document.getElementById("week-close-history-body");
    if (histBody) {
      const hist = getWeekCloses().slice(0, 8);
      histBody.innerHTML = "";
      if (!hist.length) {
        histBody.innerHTML = `<tr><td colspan="5" class="muted">Todavía no hay cierres semanales.</td></tr>`;
      } else {
        for (const w of hist) {
          const tr = document.createElement("tr");
          const diffClass =
            Math.abs(w.cashDifference) > 0.01 ? "week-close-hist-diff--warn" : "week-close-hist-diff--ok";
          tr.innerHTML = `
            <td>${c.escapeHtml(w.closeDate)}</td>
            <td class="muted">${c.escapeHtml(formatWeekLabel({ weekStart: w.weekStart, weekEnd: w.weekEnd }))}</td>
            <td>${c.currency(w.expectedTotal)}</td>
            <td>${c.currency(w.countedCash)}</td>
            <td><span class="week-close-hist-diff ${diffClass}">${c.currency(w.cashDifference)}</span></td>
          `;
          histBody.appendChild(tr);
        }
      }
    }
  }

  const ALERT_DEST = {
    deudores: "Deudores",
    ventas: "Ventas",
    garantias: "Garantías",
    inventario: "Inventario",
    configuraciones: "Comisiones",
    caja: "Caja",
  };

  const ALERT_VISIBLE_CASES = 3;
  const ALERTS_PANEL_EXPAND_KEY = "crm-resumen-alerts-expanded";
  const ALERT_CARD_EXPAND_KEY = "crm-alert-cards-expanded";

  function isAlertsPanelExpanded() {
    return localStorage.getItem(ALERTS_PANEL_EXPAND_KEY) === "1";
  }

  function setAlertsPanelExpanded(value) {
    localStorage.setItem(ALERTS_PANEL_EXPAND_KEY, value ? "1" : "0");
  }

  function getExpandedAlertCards() {
    try {
      return new Set(JSON.parse(localStorage.getItem(ALERT_CARD_EXPAND_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function setAlertCardExpanded(title, expanded) {
    const set = getExpandedAlertCards();
    if (expanded) set.add(title);
    else set.delete(title);
    localStorage.setItem(ALERT_CARD_EXPAND_KEY, JSON.stringify([...set]));
  }

  function syncAlertsPanelUI() {
    const panel = document.getElementById("resumen-alerts-panel");
    const toggle = document.getElementById("resumen-alerts-toggle");
    const body = document.getElementById("resumen-alerts-body");
    if (!panel || !toggle || !body) return;
    const expanded = isAlertsPanelExpanded();
    panel.classList.toggle("resumen-alerts-card--collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    body.hidden = !expanded;
  }

  function wireAlertsPanelToggle() {
    const toggle = document.getElementById("resumen-alerts-toggle");
    if (!toggle || toggle.dataset.wired) return;
    toggle.dataset.wired = "1";
    toggle.addEventListener("click", () => {
      setAlertsPanelExpanded(!isAlertsPanelExpanded());
      syncAlertsPanelUI();
    });
  }

  function syncAlertCardUI(card, title, expanded) {
    card.classList.toggle("alert-card--collapsed", !expanded);
    const body = card.querySelector(".alert-card__body");
    const btn = card.querySelector(".alert-card__toggle");
    if (body) body.hidden = !expanded;
    if (btn) btn.setAttribute("aria-expanded", String(expanded));
  }

  function formatAlertDate(ymdStr) {
    if (!ymdStr) return "";
    const parts = String(ymdStr).split("-").map(Number);
    if (parts.length < 3 || !parts[0]) return ymdStr;
    const months = [
      "ene",
      "feb",
      "mar",
      "abr",
      "may",
      "jun",
      "jul",
      "ago",
      "sep",
      "oct",
      "nov",
      "dic",
    ];
    return `${parts[2]} ${months[parts[1] - 1]} ${parts[0]}`;
  }

  function buildBusinessAlerts() {
    const c = crm();
    if (!c) return [];
    const mk = c.getDashboardMonthKey();
    const sales = c.salesForMonthKey(c.getSales(), mk);
    const recv = c.getReceivables();
    const inventory = c.getInventory();
    const today = ymd(new Date());
    const alerts = [];

    const overdue = recv.filter(
      (r) => r.dueDate && r.dueDate < today && c.numeric(r.amountPending, 0) > 0
    );
    if (overdue.length) {
      const sum = overdue.reduce((a, r) => a + c.numeric(r.amountPending, 0), 0);
      alerts.push({
        level: "danger",
        title: "Cuotas vencidas",
        text: `${overdue.length} pendiente(s) · ${c.currency(sum)} por cobrar`,
        tab: "deudores",
        action: {
          tab: "deudores",
          scrollTo: "tr.alert-row--overdue, tr.alert-row--match",
          inputs: { "receivables-filter-q": "", "receivables-filter-kind": "" },
        },
        items: overdue.map((r) => ({
          primary: r.clientName,
          secondary: `Vence ${formatAlertDate(r.dueDate)}`,
          meta: c.currency(r.amountPending),
          action: {
            tab: "deudores",
            highlightRecvId: r.id,
            inputs: { "receivables-filter-q": r.clientName },
          },
        })),
      });
    }

    const noImei = sales.filter((s) => !c.saleHasDeviceIdentity(s));
    if (noImei.length) {
      alerts.push({
        level: "warn",
        title: "Ventas sin serie/IMEI",
        text: `${noImei.length} pendiente(s) · completá el identificador para garantías y taller`,
        tab: "ventas",
        action: {
          tab: "ventas",
          highlightSaleIds: noImei.map((s) => s.id),
          inputs: { "sales-filter-q": "" },
        },
        items: noImei.map((s) => ({
          primary: s.client,
          secondary: s.model,
          meta: formatAlertDate(s.date),
          action: {
            tab: "ventas",
            highlightSaleId: s.id,
            openSaleId: s.id,
            inputs: { "sales-filter-q": s.client },
          },
        })),
      });
    }

    const payMismatch = sales.filter((s) => {
      const paid =
        c.numeric(s.paymentCash, 0) +
        c.numeric(s.paymentTransfer, 0) +
        c.numeric(s.paymentCard, 0) +
        c.numeric(s.paymentOther, 0);
      const total = c.numeric(s.saleTotal, 0);
      return total > 0 && Math.abs(paid - total) > 0.02;
    });
    if (payMismatch.length) {
      alerts.push({
        level: "danger",
        title: "Pagos que no cierran",
        text: `${payMismatch.length} venta(s) · la suma de medios no coincide con el total cobrado`,
        tab: "ventas",
        action: {
          tab: "ventas",
          highlightSaleIds: payMismatch.map((s) => s.id),
          inputs: { "sales-filter-q": "" },
        },
        items: payMismatch.map((s) => ({
          primary: s.client,
          secondary: s.model,
          meta: "Cobrado ≠ total",
          action: {
            tab: "ventas",
            highlightSaleId: s.id,
            openSaleId: s.id,
            inputs: { "sales-filter-q": s.client },
          },
        })),
      });
    }

    const expiring = sales.filter((s) => {
      const days = c.warrantyDaysRemaining(s.date);
      return days >= 0 && days <= 7;
    });
    if (expiring.length) {
      alerts.push({
        level: "info",
        title: "Garantías por vencer",
        text: `${expiring.length} en los próximos 7 días`,
        tab: "garantias",
        action: {
          tab: "garantias",
          inputs: { "warranty-filter": "active", "warranty-search": "" },
          highlightSaleId: expiring[0]?.id,
        },
        items: expiring.map((s) => ({
          primary: s.client,
          secondary: s.model,
          meta: `${c.warrantyDaysRemaining(s.date)} d restantes`,
          action: {
            tab: "garantias",
            highlightSaleId: s.id,
            inputs: { "warranty-search": s.client, "warranty-filter": "active" },
          },
        })),
      });
    }

    const oldStock = inventory.filter((i) => {
      if (c.numeric(i.stock, 0) <= 0 || !i.createdAt) return false;
      const days = inventoryDaysInStock(i);
      return days != null && days >= 45;
    });
    if (oldStock.length) {
      alerts.push({
        level: "warn",
        title: "Stock antiguo",
        text: `${oldStock.length} equipo(s) con más de 45 días · considerá bajar precio o promover`,
        tab: "inventario",
        action: {
          tab: "inventario",
          inputs: { "inv-stock-filter": "antiguo", "inv-stock-search": "" },
          highlightInvId: oldStock[0]?.id,
        },
        items: oldStock.map((i) => ({
          primary: [i.model, i.color].filter(Boolean).join(" "),
          secondary: `${inventoryDaysInStock(i)} días en stock`,
          meta: i.price ? c.currency(i.price) : "",
          action: {
            tab: "inventario",
            highlightInvId: i.id,
            inputs: {
              "inv-stock-filter": "antiguo",
              "inv-stock-search": i.model || "",
            },
          },
        })),
      });
    }

    const unpaidComm = sales.filter(
      (s) =>
        (s.sellerId || s.seller_id) &&
        c.numeric(s.commissionAmount ?? s.commission_amount, 0) > 0 &&
        !s.commissionPaid
    );
    if (unpaidComm.length) {
      const commSum = unpaidComm.reduce(
        (a, s) => a + c.numeric(s.commissionAmount ?? s.commission_amount, 0),
        0
      );
      alerts.push({
        level: "info",
        title: "Comisiones pendientes",
        text: `${unpaidComm.length} venta(s) · ${c.currency(commSum)} sin marcar como pagadas`,
        tab: "configuraciones",
        action: {
          tab: "configuraciones",
          configSubpanel: "vendedores",
          scrollTo: "#btn-mark-comm-paid",
        },
        items: unpaidComm.map((s) => ({
          primary: s.client,
          secondary: c.getSellerNameById?.(s.sellerId || s.seller_id) || "Vendedor",
          meta: c.currency(s.commissionAmount ?? s.commission_amount),
          action: {
            tab: "configuraciones",
            configSubpanel: "vendedores",
            scrollTo: "#btn-mark-comm-paid",
          },
        })),
      });
    }

    const bounds = getCurrentWeekBounds();
    if (!findWeekClose(bounds)) {
      const dow = new Date().getDay();
      if (dow === 6 || dow === 0) {
        alerts.push({
          level: "info",
          title: "Cierre de caja semanal",
          text: `${formatWeekLabel(bounds)} · pendiente de registrar`,
          tab: "caja",
          action: {
            tab: "caja",
            openWeekClose: true,
          },
        });
      }
    }

    return alerts;
  }

  function followAlert(action) {
    const c = crm();
    if (!action) return;
    if (c?.navigateToAlert) {
      c.navigateToAlert(action);
      return;
    }
    if (action.tab && typeof switchTab === "function") switchTab(action.tab);
  }

  const ALERT_ICONS = { danger: "!", warn: "◆", info: "i" };

  function alertCaseAriaLabel(item) {
    const parts = [item.primary, item.secondary, item.meta].filter(Boolean);
    return `Ir a ${parts.join(", ")}`;
  }

  function renderAlertCaseRow(item, idx, collapsed) {
    const esc = crm().escapeHtml;
    const hiddenClass = collapsed ? " alert-card__row-wrap--collapsed" : "";
    const metaHtml = item.meta
      ? `<span class="alert-card__case-meta">${esc(item.meta)}</span>`
      : `<span class="alert-card__case-meta alert-card__case-meta--empty" aria-hidden="true"></span>`;
    return `<li class="alert-card__row-wrap${hiddenClass}" role="listitem">
      <button type="button" class="alert-card__case" data-case-idx="${idx}" aria-label="${esc(alertCaseAriaLabel(item))}">
        <span class="alert-card__case-main">
          <span class="alert-card__case-primary">${esc(item.primary)}</span>
          <span class="alert-card__case-secondary">${esc(item.secondary || "")}</span>
        </span>
        ${metaHtml}
        <span class="alert-card__case-chevron" aria-hidden="true">›</span>
      </button>
    </li>`;
  }

  function renderResumenAlerts() {
    const list = document.getElementById("resumen-alerts-list");
    const empty = document.getElementById("resumen-alerts-empty");
    const countEl = document.getElementById("resumen-alerts-count");
    const summaryEl = document.getElementById("resumen-alerts-summary");
    const panel = document.getElementById("resumen-alerts-panel");
    const toggle = document.getElementById("resumen-alerts-toggle");
    const body = document.getElementById("resumen-alerts-body");
    if (!list) return;
    wireAlertsPanelToggle();
    const alerts = buildBusinessAlerts();
    const esc = crm().escapeHtml;
    const expandedCards = getExpandedAlertCards();
    list.innerHTML = "";
    const totalCases = alerts.reduce(
      (n, a) => n + (a.items?.length || (a.action ? 1 : 0)),
      0
    );
    if (countEl) {
      countEl.textContent = String(totalCases);
      countEl.hidden = !totalCases;
      countEl.setAttribute(
        "aria-label",
        totalCases ? `${totalCases} casos pendientes` : "Sin alertas"
      );
    }
    if (summaryEl) {
      summaryEl.textContent = alerts.length
        ? alerts
            .map((a) => {
              const n = a.items?.length || 1;
              return `${a.title} (${n})`;
            })
            .join(" · ")
        : "";
    }
    if (!alerts.length) {
      if (empty) empty.hidden = false;
      if (panel) panel.classList.remove("resumen-alerts-card--collapsed");
      if (toggle) toggle.hidden = true;
      if (body) body.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    if (toggle) toggle.hidden = false;
    syncAlertsPanelUI();
    for (const a of alerts) {
      const card = document.createElement("article");
      card.className = `alert-card alert-card--${a.level}`;
      card.setAttribute("role", "listitem");
      const icon = ALERT_ICONS[a.level] || "•";
      const dest = ALERT_DEST[a.tab] || "sección";
      const items = a.items || [];
      const hiddenCount = Math.max(0, items.length - ALERT_VISIBLE_CASES);
      const sectionBtnLabel = items.length
        ? `Ver todos en ${dest}`
        : `Ir a ${dest}`;
      const cardExpanded = expandedCards.has(a.title);
      const casesHtml =
        items.length > 0
          ? `<div class="alert-card__body" role="region" aria-label="Casos de ${esc(a.title)}"${cardExpanded ? "" : " hidden"}>
              <div class="alert-card__cases">
                <div class="alert-card__cols" aria-hidden="true">
                  <span>Detalle</span>
                  <span>Info</span>
                </div>
                <ul class="alert-card__list" role="list">
                  ${items
                    .map((it, idx) =>
                      renderAlertCaseRow(it, idx, idx >= ALERT_VISIBLE_CASES)
                    )
                    .join("")}
                </ul>
                ${
                  hiddenCount > 0
                    ? `<button type="button" class="alert-card__more">Mostrar ${hiddenCount} caso${hiddenCount === 1 ? "" : "s"} más</button>`
                    : ""
                }
              </div>
            </div>`
          : "";
      const toggleHtml =
        items.length > 0
          ? `<button type="button" class="alert-card__toggle" aria-expanded="${cardExpanded}" aria-label="Desplegar ${esc(a.title)}">
              <span class="alert-card__severity" aria-hidden="true">
                <span class="alert-card__severity-icon">${icon}</span>
              </span>
              <span class="alert-card__head-text">
                <span class="alert-card__title">
                  ${esc(a.title)}
                  <span class="alert-card__pill">${items.length}</span>
                </span>
                <span class="alert-card__sub">${esc(a.text)}</span>
              </span>
              <span class="alert-card__head-chevron" aria-hidden="true"></span>
            </button>`
          : `<div class="alert-card__static-head">
              <span class="alert-card__severity" aria-hidden="true">
                <span class="alert-card__severity-icon">${icon}</span>
              </span>
              <span class="alert-card__head-text">
                <span class="alert-card__title">${esc(a.title)}</span>
                <span class="alert-card__sub">${esc(a.text)}</span>
              </span>
            </div>`;
      card.innerHTML = `
        <header class="alert-card__head">
          ${toggleHtml}
          ${
            a.action
              ? `<button type="button" class="alert-card__section-btn">${esc(sectionBtnLabel)}</button>`
              : ""
          }
        </header>
        ${casesHtml}
      `;
      syncAlertCardUI(card, a.title, items.length ? cardExpanded : true);
      const cardToggle = card.querySelector(".alert-card__toggle");
      if (cardToggle && items.length) {
        cardToggle.addEventListener("click", () => {
          const next = card.classList.contains("alert-card--collapsed");
          setAlertCardExpanded(a.title, next);
          syncAlertCardUI(card, a.title, next);
        });
      }
      if (a.action) {
        card
          .querySelector(".alert-card__section-btn")
          ?.addEventListener("click", (ev) => {
            ev.stopPropagation();
            followAlert(a.action);
          });
      }
      card.querySelectorAll(".alert-card__case").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.caseIdx);
          const item = items[idx];
          if (item?.action) followAlert(item.action);
        });
      });
      const moreBtn = card.querySelector(".alert-card__more");
      if (moreBtn) {
        moreBtn.addEventListener("click", () => {
          card
            .querySelectorAll(".alert-card__row-wrap--collapsed")
            .forEach((row) => row.classList.remove("alert-card__row-wrap--collapsed"));
          moreBtn.hidden = true;
        });
      }
      list.appendChild(card);
    }
  }

  function validateSaleBeforeSave(ctx) {
    const c = crm();
    if (!c) return true;
    const {
      lines,
      saleTotals,
      tradeInValue,
      paymentCash,
      paymentTransfer,
      paymentCard,
      paymentOther,
      housePending,
      editingSaleId,
    } = ctx;
    const netTotal = Math.max(
      0,
      lines.reduce((a, l) => a + c.numeric(l.quantity, 0) * c.numeric(l.unitSale, 0), 0) -
        c.numeric(tradeInValue, 0)
    );
    const paid =
      c.numeric(paymentCash, 0) +
      c.numeric(paymentTransfer, 0) +
      c.numeric(paymentCard, 0) +
      c.numeric(paymentOther, 0);
    const pendingHouse = c.numeric(housePending, 0);
    const covered = paid + pendingHouse;
    if (netTotal > 0 && Math.abs(covered - netTotal) > 0.02) {
      const detail =
        pendingHouse > 0
          ? `Pagos de hoy (${c.currency(paid)}) + cuota de la casa (${c.currency(pendingHouse)}) = ${c.currency(covered)}`
          : `Los pagos (${c.currency(paid)})`;
      const ok = confirm(
        `${detail} no coinciden con el total a cobrar (${c.currency(netTotal)}). ¿Guardar igual?`
      );
      if (!ok) return false;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const profit = (saleTotals[i] ?? 0) - c.numeric(line.quantity, 0) * c.numeric(line.unitCost, 0);
      if (profit < -0.01) {
        const ok = confirm(
          `La línea ${line.model || "equipo"} tiene margen negativo (${c.currency(profit)}). ¿Guardar igual?`
        );
        if (!ok) return false;
      }
      const devId = c.resolveLineDeviceIdentity?.(line) || c.resolveSaleDeviceIdentity(line);
      const imei = devId?.imei || "";
      const serial = devId?.serial || "";
      if (imei || serial) {
        const dup = c.getSales().find((s) => {
          if (editingSaleId && String(s.id) === String(editingSaleId)) return false;
          const sid = c.resolveSaleDeviceIdentity(s);
          if (imei && sid.imei === imei) return true;
          if (serial && sid.serial === serial) return true;
          return false;
        });
        if (dup) {
          alert(
            `Ese ${imei ? "IMEI" : "número de serie"} ya está en otra venta (${dup.client}, ${dup.date}). Revisá antes de guardar.`
          );
          return false;
        }
      }
    }
    return true;
  }

  async function markCommissionsPaidForPeriod() {
    const c = crm();
    if (!c) return;
    const mk = c.getDashboardMonthKey();
    const sales = c.salesForMonthKey(c.getSales(), mk).filter(
      (s) =>
        (s.sellerId || s.seller_id) &&
        c.numeric(s.commissionAmount ?? s.commission_amount, 0) > 0 &&
        !s.commissionPaid
    );
    if (!sales.length) {
      alert("No hay comisiones pendientes de pago en el período seleccionado.");
      return;
    }
    const total = sales.reduce(
      (a, s) => a + c.numeric(s.commissionAmount ?? s.commission_amount, 0),
      0
    );
    if (
      !confirm(
        `¿Marcar como pagadas ${sales.length} comisión(es) del período por ${c.currency(total)}?\n\nNo se crean egresos nuevos (ya están en Caja al guardar cada venta).`
      )
    ) {
      return;
    }
    const now = new Date().toISOString();
    if (c.useCloud && c.supabaseClient) {
      const userId = await c.getUserId();
      for (const s of sales) {
        const { error } = await c.supabaseClient
          .from("sales")
          .update({ commission_paid: true, commission_paid_at: now })
          .eq("id", s.id)
          .eq("user_id", userId);
        if (error && /commission_paid|schema cache/i.test(error.message || "")) {
          alert(
            "Falta la columna commission_paid. Ejecutá CRM/supabase/migration_sales_commission_paid.sql en Supabase."
          );
          return;
        }
        if (error) throw error;
      }
    } else {
      const list = c.readList(c.KEYS.sales);
      for (const s of sales) {
        const idx = list.findIndex((x) => String(x.id) === String(s.id));
        if (idx >= 0) {
          list[idx].commissionPaid = true;
          list[idx].commissionPaidAt = now;
        }
      }
      c.writeList(c.KEYS.sales, list);
    }
    await c.afterDataChange();
    alert("Comisiones marcadas como pagadas.");
  }

  async function recalcCommissionsForPeriod() {
    const c = crm();
    if (!c) return;
    const mk = c.getDashboardMonthKey();
    const sales = c.salesForMonthKey(c.getSales(), mk).filter((s) => s.sellerId || s.seller_id);
    if (!sales.length) {
      alert("No hay ventas con vendedor en el período.");
      return;
    }
    if (
      !confirm(
        `¿Recalcular comisiones de ${sales.length} venta(s) del período según las reglas actuales?`
      )
    ) {
      return;
    }
    if (c.useCloud && c.supabaseClient) {
      const userId = await c.getUserId();
      for (const s of sales) {
        const comm = c.computeSaleCommission(
          s.sellerId || s.seller_id,
          c.numeric(s.saleTotal, 0)
        );
        await c.supabaseClient
          .from("sales")
          .update({
            commission_pct_applied: comm.commissionPctApplied,
            commission_amount: comm.commissionAmount,
          })
          .eq("id", s.id)
          .eq("user_id", userId);
        await c.syncCommissionCashFromSale(
          userId,
          s.id,
          s.date,
          s.client,
          comm.commissionAmount,
          comm.sellerId
        );
      }
    } else {
      const list = c.readList(c.KEYS.sales);
      for (const s of sales) {
        const comm = c.computeSaleCommission(
          s.sellerId || s.seller_id,
          c.numeric(s.saleTotal, 0)
        );
        const idx = list.findIndex((x) => String(x.id) === String(s.id));
        if (idx >= 0) {
          list[idx].commissionPctApplied = comm.commissionPctApplied;
          list[idx].commissionAmount = comm.commissionAmount;
          list[idx].sellerId = comm.sellerId;
        }
        await c.syncCommissionCashFromSale(
          null,
          s.id,
          s.date,
          s.client,
          comm.commissionAmount,
          comm.sellerId
        );
      }
      c.writeList(c.KEYS.sales, list);
    }
    await c.afterDataChange();
    alert("Comisiones recalculadas.");
  }

  function downloadCsv(filename, header, rows) {
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportSalesCsv() {
    const c = crm();
    const mk = c.getDashboardMonthKey();
    const sales = c.salesForMonthKey(c.getSales(), mk);
    const rows = sales.map((s) => [
      s.date,
      s.client,
      s.model,
      s.saleTotal,
      s.profit,
      c.getSellerNameById?.(s.sellerId || s.seller_id) || "",
      s.commissionAmount ?? s.commission_amount ?? 0,
      s.commissionPaid ? "si" : "no",
    ]);
    downloadCsv(
      `ventas_${mk}.csv`,
      ["fecha", "cliente", "modelo", "total", "ganancia", "vendedor", "comision", "comision_pagada"],
      rows
    );
  }

  function exportCashCsv() {
    const c = crm();
    const mk = c.getDashboardMonthKey();
    const bounds = getCurrentWeekBounds();
    const rows = [];
    for (const s of c.getSales()) {
      if (!c.recordInMonth(s.date, mk)) continue;
      rows.push([s.date, "venta", "reparto", `Venta ${s.client}`, s.saleTotal]);
    }
    for (const row of c.getCash()) {
      if (!c.recordInMonth(row.date, mk)) continue;
      rows.push([
        row.date,
        row.type,
        c.cashRepartoDestOf(row),
        row.concept,
        row.amount,
      ]);
    }
    downloadCsv(`caja_${mk}.csv`, ["fecha", "tipo", "destino", "concepto", "monto"], rows);
  }

  function clientProfileKey(sale) {
    const phone = String(sale.phone || "").replace(/\D/g, "");
    if (phone.length >= 8) return `p:${phone}`;
    return `n:${String(sale.client || "").trim().toLowerCase()}`;
  }

  function openClientProfile(clientName) {
    const c = crm();
    const name = String(clientName || "").trim();
    if (!name) return;
    const sales = c
      .getSales()
      .filter((s) => String(s.client || "").trim() === name)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const receivables = (c.getReceivables?.() || [])
      .filter((r) => String(r.clientName || "").trim() === name && c.numeric(r.amountPending, 0) > 0)
      .sort((a, b) => String(a.dueDate || "").localeCompare(String(b.dueDate || "")));
    const debtTotal = receivables.reduce((a, r) => a + c.numeric(r.amountPending, 0), 0);
    const modal = document.getElementById("client-profile-modal");
    const body = document.getElementById("client-profile-body");
    if (!modal || !body) return;
    const total = sales.reduce((a, s) => a + c.numeric(s.saleTotal, 0), 0);
    const phone = sales.find((s) => s.phone)?.phone || "—";
    const ig = sales.find((s) => s.igHandle)?.igHandle || "—";
    const debtBlock =
      receivables.length > 0
        ? `
      <div class="client-profile-stats" style="margin-top:0.75rem">
        <article class="client-profile-stat">
          <span class="client-profile-stat__label">Deuda pendiente</span>
          <strong class="client-profile-stat__val">${c.currency(debtTotal)}</strong>
        </article>
        <article class="client-profile-stat">
          <span class="client-profile-stat__label">Cuotas abiertas</span>
          <strong class="client-profile-stat__val">${receivables.length}</strong>
        </article>
      </div>
      <div class="table-wrap client-profile-table">
        <table>
          <thead><tr><th>Vence</th><th>Concepto</th><th>Pendiente</th></tr></thead>
          <tbody>
            ${receivables
              .map(
                (r) =>
                  `<tr><td>${r.dueDate || "—"}</td><td>${c.escapeHtml(r.concept || "")}</td><td>${c.currency(r.amountPending)}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`
        : `<p class="muted" style="margin:0.75rem 0 0">Sin deuda pendiente en Deudores.</p>`;
    body.innerHTML = `
      <div class="client-profile-hero">
        <div class="client-profile-avatar" aria-hidden="true">${c.escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="client-profile-hero__info">
          <h3 class="client-profile-name">${c.escapeHtml(name)}</h3>
          <p class="client-profile-meta muted">${c.escapeHtml(phone)}${ig !== "—" ? ` · ${c.escapeHtml(ig)}` : ""}</p>
        </div>
      </div>
      <div class="client-profile-stats">
        <article class="client-profile-stat">
          <span class="client-profile-stat__label">Compras</span>
          <strong class="client-profile-stat__val">${sales.length}</strong>
        </article>
        <article class="client-profile-stat">
          <span class="client-profile-stat__label">Total gastado</span>
          <strong class="client-profile-stat__val">${c.currency(total)}</strong>
        </article>
      </div>
      ${debtBlock}
      <div class="table-wrap client-profile-table">
        <table>
          <thead><tr><th>Fecha</th><th>Equipo</th><th>Total</th></tr></thead>
          <tbody>
            ${sales
              .map(
                (s) =>
                  `<tr><td>${s.date}</td><td>${c.escapeHtml(s.model)}</td><td>${c.currency(s.saleTotal)}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function inventoryDaysInStock(item) {
    if (!item?.createdAt) return null;
    const ing = new Date(item.createdAt);
    if (Number.isNaN(ing.getTime())) return null;
    return Math.floor((Date.now() - ing.getTime()) / 86400000);
  }

  async function loadWeekClosesFromCloud() {
    const c = crm();
    if (!c?.useCloud || !c.supabaseClient) return;
    try {
      const { data, error } = await c.supabaseClient
        .from("cash_week_closes")
        .select("*")
        .order("week_start", { ascending: false })
        .limit(52);
      if (error) {
        if (/cash_week_closes|schema cache/i.test(error.message || "")) return;
        throw error;
      }
      cacheWeekCloses = (data || []).map(weekCloseFromRow);
      writeWeekClosesLocal(cacheWeekCloses);
    } catch (e) {
      console.warn("cash_week_closes:", e);
    }
  }

  function openWeekCloseModal() {
    const modal = document.getElementById("week-close-modal");
    if (!modal) return;
    renderWeeklyCashClose();
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("sale-modal-open");
    document.getElementById("week-close-counted-cash")?.focus();
  }

  function closeWeekCloseModal() {
    const modal = document.getElementById("week-close-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    const anyOpen = document.querySelector(".sale-modal:not([hidden])");
    document.body.classList.toggle("sale-modal-open", Boolean(anyOpen));
  }

  function wireWeekCloseModal() {
    const modal = document.getElementById("week-close-modal");
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = "1";
    const close = () => closeWeekCloseModal();
    document.getElementById("week-close-modal-backdrop")?.addEventListener("click", close);
    document.getElementById("week-close-modal-close")?.addEventListener("click", close);
    document.getElementById("week-close-modal-cancel")?.addEventListener("click", close);
    document.getElementById("btn-open-week-close-modal")?.addEventListener("click", openWeekCloseModal);
  }

  function bindBusinessExtrasUi() {
    if (document.body.dataset.businessExtrasBound === "1") return;
    document.body.dataset.businessExtrasBound = "1";

    wireWeekCloseModal();

    document.getElementById("btn-week-close-save")?.addEventListener("click", async () => {
      const c = crm();
      const bounds = getCurrentWeekBounds();
      const exp = computeWeekCashExpected(bounds);
      if (!exp) return;
      const countedCash = c.numeric(document.getElementById("week-close-counted-cash")?.value, 0);
      const countedTransfer = c.numeric(
        document.getElementById("week-close-counted-transfer")?.value,
        0
      );
      const countedCard = c.numeric(document.getElementById("week-close-counted-card")?.value, 0);
      const closeDate =
        document.getElementById("week-close-date")?.value || bounds.weekEnd;
      const notes = document.getElementById("week-close-notes")?.value?.trim() || "";
      const payload = {
        week_start: bounds.weekStart,
        week_end: bounds.weekEnd,
        close_date: closeDate,
        expected_cash: exp.expectedCash,
        expected_transfer: exp.expectedTransfer,
        expected_card: exp.expectedCard,
        expected_other: exp.expectedOther,
        expected_total: exp.expectedTotal,
        counted_cash: countedCash,
        counted_transfer: countedTransfer,
        counted_card: countedCard,
        cash_difference: countedCash - exp.expectedCash,
        notes,
      };
      try {
        await saveWeekClose(payload);
        await c.afterDataChange();
        closeWeekCloseModal();
        alert("Cierre semanal guardado.");
      } catch (e) {
        alert(e.message || "No se pudo guardar el cierre.");
      }
    });

    ["week-close-counted-cash", "week-close-counted-transfer", "week-close-counted-card"].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener("input", renderWeeklyCashClose);
      }
    );

    document.getElementById("btn-mark-comm-paid")?.addEventListener("click", () => {
      void markCommissionsPaidForPeriod();
    });
    document.getElementById("btn-recalc-comm")?.addEventListener("click", () => {
      void recalcCommissionsForPeriod();
    });
    document.getElementById("btn-export-sales-csv")?.addEventListener("click", exportSalesCsv);
    document.getElementById("btn-export-cash-csv")?.addEventListener("click", exportCashCsv);

    document.getElementById("client-profile-close")?.addEventListener("click", () => {
      const m = document.getElementById("client-profile-modal");
      if (m) {
        m.hidden = true;
        m.setAttribute("aria-hidden", "true");
      }
    });
    document.getElementById("client-profile-backdrop")?.addEventListener("click", () => {
      document.getElementById("client-profile-close")?.click();
    });

    document.getElementById("recv-pay-dest-cancel")?.addEventListener("click", closeRecvPayModal);
    document.getElementById("recv-pay-dest-cancel-btn")?.addEventListener("click", closeRecvPayModal);
    function closeRecvPayModal() {
      const m = document.getElementById("recv-pay-dest-modal");
      if (m) {
        m.hidden = true;
        m.setAttribute("aria-hidden", "true");
      }
      delete window.__pendingRecvPay;
    }
    document.getElementById("recv-pay-dest-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "recv-pay-dest-backdrop") {
        closeRecvPayModal();
      }
    });
    document.getElementById("recv-pay-dest-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pending = window.__pendingRecvPay;
      if (!pending) return;
      const c = crm();
      const amount = pending.amount;
      const dest = document.getElementById("recv-pay-dest-select")?.value || "reparto";
      const egresoKind = c.repartoDestToEgresoKind(dest);
      const concept = `Cobro · ${pending.clientName} · ${pending.concept}`;
      const date = ymd(new Date());
      if (c.useCloud && c.supabaseClient) {
        const userId = await c.getUserId();
        await c.supabaseClient.from("cash_movements").insert({
          user_id: userId,
          movement_type: "ingreso",
          movement_date: date,
          concept,
          amount,
          egreso_kind: null,
          reparto_dest: dest,
        });
        if (pending.next <= 0) {
          await c.supabaseClient
            .from("pending_receivables")
            .delete()
            .eq("id", pending.id)
            .eq("user_id", userId);
        } else {
          await c.supabaseClient
            .from("pending_receivables")
            .update({ amount_pending: pending.next })
            .eq("id", pending.id)
            .eq("user_id", userId);
        }
      } else {
        const cash = c.readList(c.KEYS.cash);
        cash.unshift({
          id: crypto.randomUUID(),
          type: "ingreso",
          date,
          concept,
          amount,
          repartoDest: dest,
        });
        c.writeList(c.KEYS.cash, cash);
        const list = c.readList(c.KEYS.receivables);
        if (pending.next <= 0) {
          c.writeList(
            c.KEYS.receivables,
            list.filter((r) => String(r.id) !== String(pending.id))
          );
        } else {
          const item = list.find((r) => String(r.id) === String(pending.id));
          if (item) item.amountPending = pending.next;
          c.writeList(c.KEYS.receivables, list);
        }
      }
      closeRecvPayModal();
      await c.afterDataChange();
      if (pending.next <= 0) {
        await c.promoteCobrandoLeadsIfDebtCleared?.(pending.clientName, "");
        await c.afterDataChange?.();
      }
    });
  }

  function promptReceivablePayment(row, paid) {
    const c = crm();
    const next = Math.max(0, c.numeric(row.amountPending, 0) - paid);
    window.__pendingRecvPay = {
      id: row.id,
      amount: paid,
      next,
      clientName: row.clientName,
      concept: row.concept,
    };
    const m = document.getElementById("recv-pay-dest-modal");
    const amtEl = document.getElementById("recv-pay-dest-amount");
    if (amtEl) amtEl.textContent = c.currency(paid);
    c.populateCashRepartoDestSelect?.("ingreso", "reparto", document.getElementById("recv-pay-dest-select"));
    const sel = document.getElementById("recv-pay-dest-select");
    if (sel) sel.value = "reparto";
    if (m) {
      m.hidden = false;
      m.setAttribute("aria-hidden", "false");
    }
  }

  window.__businessExtras = {
    renderWeeklyCashClose,
    renderResumenAlerts,
    validateSaleBeforeSave,
    loadWeekClosesFromCloud,
    bindBusinessExtrasUi,
    promptReceivablePayment,
    inventoryDaysInStock,
    openClientProfile,
    openWeekCloseModal,
    getCurrentWeekBounds,
  };

  function tryBind() {
    if (!crm()) {
      setTimeout(tryBind, 50);
      return;
    }
    bindBusinessExtrasUi();
  }
  tryBind();
})();
