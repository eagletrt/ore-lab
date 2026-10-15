"use strict";

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

const MEMBERS_URL = "https://api.eagletrt.it/members";
const LEADERBOARD_URL = "https://api.eagletrt.it/lab/leaderboard";

// Aree mostrate sempre come filtro (eventuali altre aree arrivate dall'API
// vengono aggiunte in coda).
const AREAS = ["SW", "HW", "MT", "MGT", "DMT", "CM"];
const UNKNOWN_AREA = "ND";

// Ruoli filtrabili. Chi non ha nessuno di questi ruoli finisce in "Altro".
const ROLES = ["CT", "PM"];
const OTHER_ROLE = "ALTRO";
// Campo del membro (da /members) con i ruoli: array, es. ["CT", "PM"].
const ROLE_FIELD = "roles";

const FIRST_ACADEMIC_YEAR = 2023;
const ACADEMIC_YEAR_START_MONTH = 8; // settembre (0-based)
const SEARCH_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Stato
// ---------------------------------------------------------------------------

const state = {
  view: "monthly",
  groupByArea: false,
  activeOnly: false,
  search: "",
  areas: new Set(AREAS),
  roles: new Set([...ROLES, OTHER_ROLE]),
  allAreas: [...AREAS],
  members: new Map(),       // email -> { name, area, active, roles }
  membersError: null,
  hours: null,              // [{ email, ore }] del periodo corrente
  visible: [],              // voci attualmente mostrate (per il CSV)
};

const leaderboardCache = new Map();
let pendingRequest = null;
let membersReady = Promise.resolve();

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Utility date (sempre in ora locale, niente toISOString che sposta di un giorno)
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toISOMonth = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function parseISODate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
}

function currentAcademicYear(date = new Date()) {
  return date.getMonth() >= ACADEMIC_YEAR_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;
}

const longDate = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric" });
const longMonth = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric" });
const hoursFormat = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatHours = (h) => `${hoursFormat.format(h)} h`;

// ---------------------------------------------------------------------------
// Periodo selezionato
// ---------------------------------------------------------------------------

function getPeriod() {
  switch (state.view) {
    case "monthly": {
      const value = $("month-select").value;
      if (!value) return null;
      const start = parseISODate(value);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      return { since: toISODate(start), until: toISODate(end), label: longMonth.format(start), slug: value };
    }
    case "yearly": {
      const year = Number($("year-select").value);
      if (!year) return null;
      return {
        since: `${year}-09-01`,
        until: `${year + 1}-08-31`,
        label: `${year}–${year + 1}`,
        slug: `${year}-${year + 1}`,
      };
    }
    case "daily":
    default: {
      const value = $("day-select").value;
      if (!value) return null;
      return { since: value, until: value, label: longDate.format(parseISODate(value)), slug: value };
    }
  }
}

function shiftPeriod(direction) {
  if (state.view === "daily") {
    const d = parseISODate($("day-select").value || toISODate(new Date()));
    d.setDate(d.getDate() + direction);
    $("day-select").value = toISODate(d);
  } else if (state.view === "monthly") {
    const d = parseISODate($("month-select").value || toISOMonth(new Date()));
    d.setMonth(d.getMonth() + direction);
    $("month-select").value = toISOMonth(d);
  } else {
    const select = $("year-select");
    const next = select.selectedIndex + direction;
    if (next < 0 || next >= select.options.length) return;
    select.selectedIndex = next;
  }
  loadPeriod();
}

function resetPeriodToToday() {
  const today = new Date();
  $("day-select").value = toISODate(today);
  $("month-select").value = toISOMonth(today);
  $("year-select").value = String(currentAcademicYear(today));
  loadPeriod();
}

// Disabilita "successivo" quando si è già sul periodo corrente
function updatePeriodNav() {
  const today = new Date();
  let atEnd;
  if (state.view === "daily") {
    atEnd = $("day-select").value >= toISODate(today);
  } else if (state.view === "monthly") {
    atEnd = $("month-select").value >= toISOMonth(today);
  } else {
    const select = $("year-select");
    atEnd = select.selectedIndex >= select.options.length - 1;
  }
  $("next-period").disabled = atEnd;
  $("prev-period").disabled = state.view === "yearly" && $("year-select").selectedIndex <= 0;
}

function setupPeriodInputs() {
  const today = new Date();
  $("day-select").value = toISODate(today);
  $("day-select").max = toISODate(today);
  $("month-select").value = toISOMonth(today);
  $("month-select").max = toISOMonth(today);

  const select = $("year-select");
  const lastYear = currentAcademicYear(today);
  for (let year = FIRST_ACADEMIC_YEAR; year <= lastYear; year++) {
    select.add(new Option(`${year}–${year + 1}`, year));
  }
  select.value = String(lastYear);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".segment").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.view === view));
  });
  document.querySelectorAll("[data-view-input]").forEach((el) => {
    el.hidden = el.dataset.viewInput !== view;
  });
  loadPeriod();
}

// ---------------------------------------------------------------------------
// Dati
// ---------------------------------------------------------------------------

function parseRoles(raw) {
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;/|]+/);
  const roles = values
    .map((r) => String(r).trim().toUpperCase())
    .filter((r) => ROLES.includes(r));
  return roles.length ? [...new Set(roles)] : [OTHER_ROLE];
}

async function loadMembers() {
  try {
    const response = await fetch(MEMBERS_URL, {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    for (const member of data.members ?? []) {
      if (!member.email) continue;
      const area = (member.area || UNKNOWN_AREA).toUpperCase();
      state.members.set(member.email.toLowerCase(), {
        name: member.name || member.email,
        area,
        active: Boolean(member.active),
        roles: parseRoles(member[ROLE_FIELD]),
      });
      if (!state.allAreas.includes(area)) {
        state.allAreas.push(area);
        state.areas.add(area);
      }
    }
  } catch (error) {
    console.error("Errore caricamento membri:", error);
    state.membersError = "Impossibile caricare l'anagrafica dei membri: nomi, aree e ruoli potrebbero mancare.";
  }
}

async function fetchLeaderboard(period, signal) {
  const params = new URLSearchParams({ since: period.since, until: period.until });
  const url = `${LEADERBOARD_URL}?${params}`;
  if (leaderboardCache.has(url)) return leaderboardCache.get(url);

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Errore server: ${response.status}`);
  }

  const data = await response.json().catch(() => null);
  if (!data || typeof data.leaderboard !== "object") throw new Error("Formato dati non valido");

  const hours = Object.entries(data.leaderboard).map(([email, ore]) => ({
    email: email.toLowerCase(),
    ore: Number.parseFloat(ore) || 0,
  }));
  leaderboardCache.set(url, hours);
  return hours;
}

async function loadPeriod() {
  updatePeriodNav();
  const period = getPeriod();
  $("period-label").textContent = period ? `· ${period.label}` : "";
  if (!period) {
    showStatus("Seleziona un periodo valido.");
    return;
  }

  pendingRequest?.abort();
  const controller = new AbortController();
  pendingRequest = controller;

  setBusy(true);
  try {
    const hours = await fetchLeaderboard(period, controller.signal);
    await membersReady;
    if (pendingRequest !== controller) return;
    state.hours = hours;
    render();
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error("Errore durante il caricamento:", error);
    state.hours = null;
    showStatus(`Errore: ${error.message}`, true);
  } finally {
    if (pendingRequest === controller) {
      pendingRequest = null;
      setBusy(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Filtri
// ---------------------------------------------------------------------------

function memberInfo(email) {
  return state.members.get(email) ?? { name: email, area: UNKNOWN_AREA, active: false, roles: [OTHER_ROLE] };
}

function getVisibleEntries() {
  const query = state.search;
  return state.hours
    .map(({ email, ore }) => ({ email, ore, ...memberInfo(email) }))
    .filter((e) =>
      (!state.activeOnly || e.active) &&
      state.areas.has(e.area) &&
      e.roles.some((r) => state.roles.has(r)) &&
      (!query || e.name.toLowerCase().includes(query) || e.email.includes(query))
    )
    .sort((a, b) => b.ore - a.ore || a.name.localeCompare(b.name, "it"));
}

function buildChips(containerId, values, selected, labels = {}) {
  const container = $(containerId);
  container.replaceChildren(
    ...values.map((value) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.value = value;
      chip.textContent = labels[value]?.text ?? value;
      if (labels[value]?.title) chip.title = labels[value].title;
      chip.setAttribute("aria-pressed", String(selected.has(value)));
      chip.addEventListener("click", () => {
        selected.has(value) ? selected.delete(value) : selected.add(value);
        chip.setAttribute("aria-pressed", String(selected.has(value)));
        render();
      });
      return chip;
    })
  );
}

function setAll(kind, on) {
  const [set, values, containerId] =
    kind === "area"
      ? [state.areas, state.allAreas, "area-filters"]
      : [state.roles, [...ROLES, OTHER_ROLE], "role-filters"];
  set.clear();
  if (on) values.forEach((v) => set.add(v));
  $(containerId).querySelectorAll(".chip").forEach((chip) => chip.setAttribute("aria-pressed", String(on)));
}

function renderFilters() {
  buildChips("area-filters", state.allAreas, state.areas, {
    [UNKNOWN_AREA]: { text: UNKNOWN_AREA, title: "Area non definita" },
  });
  buildChips("role-filters", [...ROLES, OTHER_ROLE], state.roles, {
    [OTHER_ROLE]: { text: "Altro", title: `Membri senza ruolo ${ROLES.join(", ")}` },
  });
}

function resetFilters() {
  setAll("area", true);
  setAll("role", true);
  $("name-search").value = "";
  $("active-only").checked = false;
  $("group-by-area").checked = false;
  state.search = "";
  state.activeOnly = false;
  state.groupByArea = false;
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setBusy(busy) {
  $("leaderboard").setAttribute("aria-busy", String(busy));
  if (busy && !state.hours) showStatus("Caricamento dati…");
}

function showStatus(message, isError = false) {
  const p = document.createElement("p");
  p.className = isError ? "status status-error" : "status";
  p.textContent = message;
  $("leaderboard").replaceChildren(p);
  $("stats").hidden = true;
  $("export-csv").disabled = true;
  state.visible = [];
}

// Classifica "a pari merito": stesse ore => stessa posizione
function withRanks(entries) {
  let rank = 0;
  return entries.map((entry, i) => {
    if (i === 0 || entry.ore !== entries[i - 1].ore) rank = i + 1;
    return { ...entry, rank };
  });
}

function createEntry(entry, maxHours) {
  const node = $("entry-template").content.firstElementChild.cloneNode(true);
  if (entry.rank <= 3 && entry.ore > 0) node.classList.add(`podium-${entry.rank}`);

  node.querySelector(".entry-rank").textContent = entry.rank;
  node.querySelector(".entry-name").textContent = entry.name;
  node.querySelector(".entry-email").textContent = entry.email;
  node.querySelector(".entry-hours").textContent = formatHours(entry.ore);
  node.querySelector(".entry-bar span").style.width = `${maxHours > 0 ? (entry.ore / maxHours) * 100 : 0}%`;

  const tags = node.querySelector(".entry-tags");
  const addTag = (text, cls) => {
    const tag = document.createElement("span");
    tag.className = `tag ${cls}`;
    tag.textContent = text;
    tags.append(tag);
  };
  addTag(entry.area, "tag-area");
  entry.roles.filter((r) => r !== OTHER_ROLE).forEach((r) => addTag(r, "tag-role"));
  if (!entry.active && state.members.has(entry.email)) addTag("non attivo", "tag-muted");

  return node;
}

function createList(entries) {
  const list = document.createElement("ol");
  list.className = "entries";
  const ranked = withRanks(entries);
  const max = ranked[0]?.ore ?? 0;
  list.append(...ranked.map((e) => createEntry(e, max)));
  return list;
}

function createAreaSection(area, entries) {
  const total = entries.reduce((sum, e) => sum + e.ore, 0);
  const section = document.createElement("section");
  section.className = "area-section";

  const header = document.createElement("header");
  header.className = "area-header";
  const title = document.createElement("h3");
  title.textContent = area;
  const meta = document.createElement("span");
  meta.className = "area-meta";
  meta.textContent = `${entries.length} ${entries.length === 1 ? "membro" : "membri"} · ${formatHours(total)}`;
  header.append(title, meta);

  section.append(header, createList(entries));
  return section;
}

function renderStats(entries) {
  const total = entries.reduce((sum, e) => sum + e.ore, 0);
  $("stat-members").textContent = entries.length;
  $("stat-total").textContent = formatHours(total);
  $("stat-avg").textContent = formatHours(entries.length ? total / entries.length : 0);
  $("stats").hidden = false;
}

function render() {
  if (!state.hours) return;

  if (state.areas.size === 0) return showStatus("Seleziona almeno un'area.");
  if (state.roles.size === 0) return showStatus("Seleziona almeno un ruolo.");

  const entries = getVisibleEntries();
  state.visible = entries;
  const container = $("leaderboard");

  if (entries.length === 0) {
    showStatus("Nessun membro trovato per i criteri selezionati.");
    return;
  }

  const nodes = [];
  if (state.membersError) {
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = state.membersError;
    nodes.push(notice);
  }

  if (state.groupByArea) {
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.area)) groups.set(entry.area, []);
      groups.get(entry.area).push(entry);
    }
    const order = (a) => (state.allAreas.indexOf(a) + 1) || Infinity;
    [...groups.keys()]
      .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
      .forEach((area) => nodes.push(createAreaSection(area, groups.get(area))));
  } else {
    nodes.push(createList(entries));
  }

  container.replaceChildren(...nodes);
  renderStats(entries);
  $("export-csv").disabled = false;
}

// ---------------------------------------------------------------------------
// Esportazione CSV
// ---------------------------------------------------------------------------

function csvCell(value) {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV() {
  if (state.visible.length === 0) return;

  const header = ["Posizione", "Nome", "Email", "Area", "Ruolo", "Ore totali"];
  const rows = withRanks(state.visible).map((e) => [
    e.rank,
    e.name,
    e.email,
    e.area,
    e.roles.map((r) => (r === OTHER_ROLE ? "Altro" : r)).join(" "),
    e.ore.toFixed(2),
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

  // BOM così Excel legge correttamente gli accenti
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ore_${getPeriod()?.slug ?? "export"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Eventi e avvio
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function setupEventListeners() {
  document.querySelectorAll(".segment").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  ["day-select", "month-select", "year-select"].forEach((id) => $(id).addEventListener("change", loadPeriod));
  $("prev-period").addEventListener("click", () => shiftPeriod(-1));
  $("next-period").addEventListener("click", () => shiftPeriod(1));
  $("today-btn").addEventListener("click", resetPeriodToToday);

  document.querySelectorAll("[data-select-all]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setAll(btn.dataset.selectAll, true);
      render();
    });
  });
  document.querySelectorAll("[data-select-none]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setAll(btn.dataset.selectNone, false);
      render();
    });
  });

  $("name-search").addEventListener(
    "input",
    debounce((e) => {
      state.search = e.target.value.trim().toLowerCase();
      render();
    }, SEARCH_DEBOUNCE_MS)
  );
  $("active-only").addEventListener("change", (e) => {
    state.activeOnly = e.target.checked;
    render();
  });
  $("group-by-area").addEventListener("change", (e) => {
    state.groupByArea = e.target.checked;
    render();
  });
  $("reset-filters").addEventListener("click", resetFilters);
  $("export-csv").addEventListener("click", exportCSV);
}

document.addEventListener("DOMContentLoaded", () => {
  setupPeriodInputs();
  setupEventListeners();
  membersReady = loadMembers().then(renderFilters);
  setView(state.view);
});
