const API_URL = '/api/config';

const FIVEM_CONFIG_URL = '/api/fivem/config';

const DATA_URL = '/api/data';



// Elements

const loadingOverlay = document.getElementById('loading');

const toast = document.getElementById('toast');

const pageTitle = document.getElementById('page-title');

const pageSubtitle = document.getElementById('page-subtitle');

const navItems = document.querySelectorAll('.nav-item');

const dropdownHeaders = document.querySelectorAll('.dropdown-header');

const sections = document.querySelectorAll('.config-section');



// Inputs

const colorInput = document.getElementById('ACCENT_COLOR');

const colorPreview = document.getElementById('color-preview');

const colorPreviewBox = document.getElementById('color-preview-box');



// Global Data

let currentConfig = {};

let currentFiveMConfig = {};

let serverData = { channels: [], roles: [], categories: [], emojis: [] };

let currentServerData = {}; // Store raw fetching result for modal

let userPermissions = [];

let hasUnsavedChanges = false;



// Initialization

document.addEventListener('DOMContentLoaded', async () => {

    // Login Handling

    document.getElementById('login-form').addEventListener('submit', handleLogin);

    // Enter-Taste in Eingabefeldern darf die Seite nicht neu laden (Form-Submit)
    const configForm = document.getElementById('config-form');
    if (configForm) configForm.onsubmit = (e) => e.preventDefault();

    if (!checkLogin()) return; // Stop if not logged in



    // Set Avatar from Storage immediately

    const savedUser = localStorage.getItem('adminUser') || 'Admin';

    const avatar = document.getElementById('user-avatar');

    if (avatar) avatar.textContent = savedUser.charAt(0).toUpperCase();



    setupNavigation();

    setupDropdowns();

    setupColorPicker();

    setupPasswordToggle();

    setupBuilders(); // Add listeners for "Add" buttons



    await loadInitialData();

    await fetchAdmins(); // Load admins if possible



    // Start Status & Konsolen-Polling

    startPolling();

});



// --- POLLING (Status + Konsole) ---

let statusPollTimer = null;

function startPolling() {

    if (!statusPollTimer) {

        statusPollTimer = setInterval(fetchServerStatus, 5000);

        fetchServerStatus();

    }

    setupConsoleInput();

    startConsolePolling();

    // Jobs für den Spieler-Editor laden (nur mit Berechtigung relevant)

    if (canEditPlayers() && serverJobs.length === 0) fetchJobs();

}



async function fetchServerStatus() {

    try {

        const res = await fetchWithAuth('/api/fivem/status', { cache: 'no-store' });

        if (res) {

            const data = await res.json();

            currentServerData = data;

            setSidebarStatus(data.online ? 'online' : 'warn');

            updateDashboard(data);

            updatePlayerListPage(data);

            updateLivemapMarkers(data);

            refreshPlayerModal();

        }

    } catch (e) {

        console.warn("Status fetch failed", e);

        setSidebarStatus('offline');

    }

}



// Status-Leuchte unten links in der Sidebar (echter Live-Status)

function setSidebarStatus(state) {

    const dot = document.getElementById('sidebar-status-indicator');

    const value = document.getElementById('sidebar-status-value');

    if (!dot || !value) return;

    dot.classList.remove('online', 'warn', 'offline');

    if (state === 'online') {

        dot.classList.add('online');

        value.textContent = 'Server Online';

    } else if (state === 'warn') {

        dot.classList.add('warn');

        value.textContent = 'Game Server Offline';

    } else {

        dot.classList.add('offline');

        value.textContent = 'Verbindung getrennt';

    }

}



function updateDashboard(data) {

    const badge = document.getElementById('server-status-badge');

    const count = document.getElementById('live-player-count');

    const ping = document.getElementById('live-ping-avg');

    const list = document.getElementById('player-list-container');



    if (!badge || !count) return;



    // Permissions Check

    if (!userPermissions.includes('view_players') && !userPermissions.includes('all')) {

        const statusCard = document.getElementById('live-server-status-card');

        if (statusCard) statusCard.style.display = 'none';

        return; // Stop updating

    } else {

        const statusCard = document.getElementById('live-server-status-card');

        if (statusCard) statusCard.style.display = '';

    }



    if (data.online) {

        badge.textContent = "Online";

        badge.style.background = "#00ff88";

        badge.style.color = "#000";



        count.textContent = `${data.count} / ${data.max}`;



        // Avg ping

        if (data.players.length > 0) {

            const avg = Math.round(data.players.reduce((a, b) => a + (b.ping || 0), 0) / data.players.length);

            ping.textContent = `${avg} ms`;

        } else {

            ping.textContent = "- ms";

        }



        // List

        if (data.players.length === 0) {

            list.innerHTML = '<div style="text-align:center; color:#555; padding: 20px;">Server ist leer.</div>';

        } else {

            list.innerHTML = data.players.map(p => `

                <div class="dashboard-player-row" onclick="showPlayerDetails('${p.id}')">

                    <span><span style="color:#666; width:30px; display:inline-block;">${p.id}</span> <b>${escapeHtml(p.name)}</b></span>

                    <span style="color:#888;">${p.ping}ms</span>

                </div>

            `).join('');

        }



    } else {

        badge.textContent = "Offline";

        badge.style.background = "#ff4444";

        badge.style.color = "#fff";

        count.textContent = "- / -";

        ping.textContent = "- ms";

        list.innerHTML = '<div style="text-align:center; color:#555; padding: 20px;">Keine Verbindung zum Server (Resource fehlt oder Server aus).</div>';

    }

}



async function loadInitialData() {

    showLoading(true);

    suppressAutoSave = true; // kein Auto-Save während Laden/Befüllen

    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }

    try {

        // Parallel fetch (mit Auth-Token; FiveM-Config & Guild-Daten sind optional)

        const [configRes, fivemConfigRes, dataRes] = await Promise.all([

            fetchWithAuth(API_URL),

            fetchWithAuth(FIVEM_CONFIG_URL).catch(() => null),

            fetchWithAuth(DATA_URL).catch(() => null)

        ]);



        if (!configRes) return; // Session abgelaufen -> Login-Overlay wird angezeigt

        currentConfig = await configRes.json();



        if (fivemConfigRes) {

            currentFiveMConfig = await fivemConfigRes.json();

        } else {

            console.warn("Failed to fetch FiveM config");

            currentFiveMConfig = {};

        }



        if (dataRes) {

            serverData = await dataRes.json();

        } else {

            console.warn("Could not fetch server data, falling back to ID inputs");

        }



        initializeUI();



    } catch (error) {

        console.error(error);

        showToast('Fehler beim Laden: ' + error.message, 'error');

    } finally {

        showLoading(false);

    }

}



function initializeUI() {

    // 0. Dashboard-Infos

    const portDisplay = document.getElementById('display-port');

    if (portDisplay) portDisplay.textContent = currentConfig.WEB_PORT || '-';

    // 1. Populate Dropdowns

    populateDropdowns();



    // 2. Populate Standard Inputs (Merge configs for unified form population)

    populateForm({ ...currentConfig, ...currentFiveMConfig });



    // 3. Populate Builders

    buildVoteChannels(currentConfig.VOTE_CHANNELS || {});

    buildRoleSync(currentConfig.ROLE_SYNC_MAPPING || {});

    buildTicketTypes(currentConfig.TICKET_TYPES || {});

    buildTags('waiting-rooms-builder', currentConfig.WAITING_ROOMS, 'channel');

    buildTags('thumbs-up-builder', currentConfig.THUMBS_UP_CHANNELS, 'channel');



    // Ticket Admins

    buildTicketAdmins(currentConfig.TICKET_PERMANENT_ADMINS || []);



    // FiveM Lists (Use separate config)

    buildFiveMLists(currentFiveMConfig.FIVEM_WHITELIST || [], currentFiveMConfig.FIVEM_BANLIST || []);



    setupChangeListeners();

    // Reset flag because builders might have triggered it

    hasUnsavedChanges = false;

    // Befüllen ist abgeschlossen -> Auto-Save ab jetzt erlauben

    suppressAutoSave = false;

}



function setupChangeListeners() {

    // Listen to changes on all form inputs within config sections

    const inputs = document.querySelectorAll('#config-form input, #config-form select, #config-form textarea');

    inputs.forEach(input => {

        // Konsolen-, Such- und Kartenfilter-Felder sind keine Config-Werte

        if (['console-input', 'all-player-search', 'map-filter-search', 'map-filter-job', 'jobs-search', 'jobs-create-search'].includes(input.id)) return;

        // Exclude some if needed, but generally correct

        input.addEventListener('change', markDirty);

        input.addEventListener('input', markDirty);

    });



    // Also need to catch builder changes (add/remove tags/rows).

    // We can manually set hasUnsavedChanges = true in those functions.

}



// Wird durch Auto-Save ersetzt; Funktion bleibt als No-Op erhalten, damit
// bestehende Aufrufe (Navigation, Init) harmlos sind.
function updateSaveButtonVisibility() {}

// --- AUTO-SAVE ---

let autoSaveTimer = null;

let suppressAutoSave = true; // während des initialen Ladens/Befüllens kein Auto-Save



// Wird bei jeder Änderung aufgerufen: markiert ungespeicherte Änderungen und plant das Speichern

function markDirty() {

    hasUnsavedChanges = true;

    scheduleAutoSave();

}



function scheduleAutoSave() {

    if (suppressAutoSave) return;

    if (autoSaveTimer) clearTimeout(autoSaveTimer);

    autoSaveTimer = setTimeout(() => {

        autoSaveTimer = null;

        saveConfig();

    }, 700);

}



// Kleiner Indikator unten rechts (Speichern… / Gespeichert / Fehler)

let autosaveHideTimer = null;

function showAutosave(state) {

    const el = document.getElementById('autosave-indicator');

    if (!el) return;

    const icon = el.querySelector('.asi-icon');

    const text = el.querySelector('.asi-text');

    el.classList.remove('hidden', 'saving', 'saved', 'error');

    if (autosaveHideTimer) { clearTimeout(autosaveHideTimer); autosaveHideTimer = null; }



    if (state === 'saving') {

        el.classList.add('saving');

        icon.className = 'fas fa-circle-notch fa-spin asi-icon';

        text.textContent = 'Speichern…';

    } else if (state === 'saved') {

        el.classList.add('saved');

        icon.className = 'fas fa-check asi-icon';

        text.textContent = 'Gespeichert';

        autosaveHideTimer = setTimeout(() => el.classList.add('hidden'), 1800);

    } else if (state === 'error') {

        el.classList.add('error');

        icon.className = 'fas fa-exclamation-triangle asi-icon';

        text.textContent = 'Fehler beim Speichern';

        autosaveHideTimer = setTimeout(() => el.classList.add('hidden'), 4500);

    }

}



function canSaveMainConfig() {

    return ['all', 'manage_general', 'manage_channels', 'manage_roles', 'manage_tickets', 'manage_reactions']

        .some(p => userPermissions.includes(p));

}



function canSaveFivemConfig() {

    return userPermissions.includes('all') || userPermissions.includes('manage_fivem_settings');

}



function populateDropdowns() {

    const Selects = document.querySelectorAll('select.dynamic-select');

    Selects.forEach(select => {

        const type = select.dataset.type;

        let options = [];



        if (type === 'channel') options = serverData.channels || [];

        if (type === 'role') options = serverData.roles || [];

        if (type === 'category') options = serverData.categories || [];

        if (type === 'user_or_role') {

            options = [...(serverData.roles || [])]; // Users harder to fetch all, maybe just roles for now

        }



        // Clear options but add default

        select.innerHTML = '';



        // Add default "None" option if it's a single select

        if (!select.multiple && !select.id.includes('builder')) { // exclude builder selects

            const noneOpt = document.createElement('option');

            noneOpt.value = "";

            noneOpt.textContent = "--- Auswählen ---";

            select.appendChild(noneOpt);

        }



        options.forEach(item => {

            const opt = document.createElement('option');

            opt.value = item.id;

            opt.textContent = type === 'role' ? `@${item.name}` : `#${item.name}`;

            if (type === 'category') opt.textContent = `📂 ${item.name}`;

            // Discord liefert Rollenfarben bereits als "#rrggbb"

            if (item.color && item.color !== '0' && item.color !== '#000000') {

                opt.style.color = item.color.startsWith('#') ? item.color : `#${parseInt(item.color).toString(16).padStart(6, '0')}`;

            }

            select.appendChild(opt);

        });

    });

}



function populateForm(config) {

    for (const [key, value] of Object.entries(config)) {

        const input = document.getElementById(key); // or name? ID is safer for direct match

        // Or find by name if input not found by ID? mostly ID matches Key.



        // Special case: The new Role Select has name FIVEM_WHITELIST_ROLE_ID but ID fivem-whitelist-role-select

        // So we might miss it with direct ID lookup if we only rely on config keys matching IDs.

        // Better strategy: Loop inputs? No, config keys are truth.



        // FIX: Also check by name if ID fails

        let targetEl = input;

        if (!targetEl) {

            targetEl = document.querySelector(`[name="${key}"]`);

        }



        if (targetEl) {

            if (targetEl.type === 'checkbox') {

                targetEl.checked = (value === true || value === 'true');

            } else if (targetEl.tagName === 'SELECT') {

                targetEl.value = value;

            } else if (targetEl.tagName === 'TEXTAREA') {

                if (!targetEl.id.includes('builder')) { // Skip builder hidden textareas

                    if (typeof value === 'object' && value !== null) {

                        targetEl.value = JSON.stringify(value, null, 4);

                    } else {

                        targetEl.value = value;

                    }

                }

            } else if (key === 'ACCENT_COLOR') {

                targetEl.value = value;

                const hex = '#' + parseInt(value).toString(16).padStart(6, '0');

                if (colorPreview) colorPreview.value = hex;

                if (colorPreviewBox) colorPreviewBox.style.background = hex;

            } else {

                targetEl.value = value;

            }

        }

    }

}



// --- UI BUILDERS ---



function getName(id, type) {

    if (!id) return 'Unbekannt';

    const list = type === 'channel' ? serverData.channels : (type === 'role' ? serverData.roles : serverData.categories);

    const item = list.find(i => i.id == id);

    return item ? item.name : id;

}



// 1. Vote Channels

function buildVoteChannels(data) {

    const container = document.getElementById('vote-channels-builder');

    container.innerHTML = '';



    for (const [channelId, emojis] of Object.entries(data)) {

        addVoteChannelRow(channelId, emojis);

    }

}



function addVoteChannelRow(channelId = '', emojis = []) {

    const container = document.getElementById('vote-channels-builder');

    const row = document.createElement('div');

    row.className = 'builder-row';



    // Channel Select

    const select = document.createElement('select');

    select.className = 'select-input';

    select.innerHTML = `<option value="">Kanal wählen...</option>`;

    serverData.channels.forEach(c => {

        select.innerHTML += `<option value="${c.id}" ${c.id == channelId ? 'selected' : ''}>#${c.name}</option>`;

    });



    // Emoji Input

    const emojiInput = document.createElement('input');

    emojiInput.type = 'text';

    emojiInput.placeholder = '👍, 👎 (Komma getrennt)';

    emojiInput.value = Array.isArray(emojis) ? emojis.join(', ') : emojis;



    // Delete Button

    const delBtn = document.createElement('button');

    delBtn.className = 'del-btn';

    delBtn.innerHTML = '<i class="fas fa-trash"></i>';

    delBtn.onclick = () => {

        row.remove();

        markDirty();

    };



    row.appendChild(select);

    row.appendChild(emojiInput);

    row.appendChild(delBtn);

    container.appendChild(row);



    // Listeners for inputs in this new row

    select.addEventListener('change', () => { markDirty(); });

    emojiInput.addEventListener('input', () => { markDirty(); });

}



// 2. Role Sync

function buildRoleSync(data) {

    const container = document.getElementById('role-sync-builder');

    container.innerHTML = '';



    for (const [targetId, sourceIds] of Object.entries(data)) {

        addRoleSyncRow(targetId, sourceIds);

    }

}



function addRoleSyncRow(targetId = '', sourceIds = []) {

    const container = document.getElementById('role-sync-builder');

    const row = document.createElement('div');

    row.className = 'builder-card'; // Changed to card for better layout

    const uniqueId = 'sync-' + Math.random().toString(36).substr(2, 9);



    // Target Role Select

    const roleOptions = serverData.roles.map(r =>

        `<option value="${r.id}" ${r.id == targetId ? 'selected' : ''}>@${r.name}</option>`

    ).join('');



    // Source Roles Source Select

    const sourceOptions = serverData.roles.map(r =>

        `<option value="${r.id}">@${r.name}</option>`

    ).join('');



    row.innerHTML = `

        <div class="row-header">

            <div style="flex:1">

                 <label style="display:block; font-size:0.75rem; color:#888; margin-bottom:4px;">Ziel Rolle</label>

                 <select class="select-input target-role-select">

                    <option value="">Wählen...</option>

                    ${roleOptions}

                 </select>

            </div>

            <button class="del-btn" onclick="this.parentElement.parentElement.remove(); markDirty();"><i class="fas fa-trash"></i></button>

        </div>

        <div class="row-body">

             <div class="form-group-small full">

                 <label>Benötigte Quell-Rollen (Eine davon reicht)</label>

                 <div id="${uniqueId}" class="tag-builder"></div>

                 <select class="select-input" onchange="addTagTo('${uniqueId}', this)">

                    <option value="">+ Quell-Rolle hinzufügen</option>

                    ${sourceOptions}

                 </select>

            </div>

        </div>

    `;

    container.appendChild(row);



    // Populate source roles

    if (sourceIds && Array.isArray(sourceIds)) {

        sourceIds.forEach(id => addTag(uniqueId, id, 'role'));

    }

}



// 3. Ticket Types

function buildTicketTypes(data) {

    const container = document.getElementById('ticket-types-builder');

    container.innerHTML = '';



    for (const [key, typeData] of Object.entries(data)) {

        addTicketTypeRow(key, typeData);

    }

}



function addTicketTypeRow(key = '', data = { label: 'Support', prefix: 'ticket', roles: [] }) {

    const container = document.getElementById('ticket-types-builder');

    const row = document.createElement('div');

    row.className = 'builder-card';

    const uniqueId = 'roles-' + Math.random().toString(36).substr(2, 9);



    // Generate Role Options

    const roleOptions = serverData.roles.map(r =>

        `<option value="${r.id}">@${r.name}</option>`

    ).join('');



    row.innerHTML = `

        <div class="row-header">

            <input type="text" class="key-input" placeholder="ID (z.B. support)" value="${key}">

            <button class="del-btn" type="button" onclick="this.parentElement.parentElement.remove(); markDirty();"><i class="fas fa-times"></i></button>

        </div>

        <div class="row-body">

            <div class="form-group-small">

                <label>Label</label>

                <input type="text" class="label-input" value="${data.label || ''}">

            </div>

            <div class="form-group-small">

                 <label>Prefix</label>

                <input type="text" class="prefix-input" value="${data.prefix || ''}">

            </div>

             <div class="form-group-small full">

                 <label>Zuständige Rollen</label>

                 <div id="${uniqueId}" class="tag-builder"></div>

                 <select class="select-input" onchange="addTagTo('${uniqueId}', this)">

                    <option value="">+ Rolle hinzufügen</option>

                    ${roleOptions}

                 </select>

            </div>

        </div>

    `;

    container.appendChild(row);



    // Populate existing roles

    if (data.roles && Array.isArray(data.roles)) {

        data.roles.forEach(roleId => addTag(uniqueId, roleId, 'role'));

    }

}



function addTagTo(containerId, select) {

    if (select.value) {

        addTag(containerId, select.value, 'role', true);

        select.value = "";

    }

}



// Ticket Admins

function buildTicketAdmins(ids) {

    buildTags('ticket-admins-builder', ids || [], 'role');

}



function addTicketAdmin() {

    const select = document.getElementById('ticket-admin-select');

    if (select.value) {

        addTag('ticket-admins-builder', select.value, 'user_or_role', true);

        select.value = "";

    }

}



// FiveM Lists

function buildFiveMLists(whitelist, banlist) {

    buildTags('fivem-whitelist-builder', whitelist || [], 'identifier');

    buildTags('fivem-banlist-builder', banlist || [], 'identifier');

}



function addFiveMListEntry(type) {

    const inputId = type === 'whitelist' ? 'fivem-whitelist-input' : 'fivem-banlist-input';

    const builderId = type === 'whitelist' ? 'fivem-whitelist-builder' : 'fivem-banlist-builder';

    const input = document.getElementById(inputId);

    if (input && input.value.trim() !== "") {

        addTag(builderId, input.value.trim(), 'identifier', true);

        input.value = "";

    }

}



// 4. Generic Tag Builder (Waiting Rooms, Thumbs Up)

function buildTags(containerId, ids = [], type) {

    const container = document.getElementById(containerId);

    container.innerHTML = '';

    if (!ids) return;



    ids.forEach(id => {

        addTag(containerId, id, type, false); // False = loading from config

    });

}



function addTag(containerId, id, type, isNew = true) {

    const container = document.getElementById(containerId);



    // Check duplicates?

    if ([...container.children].some(c => c.dataset.id === id)) return;



    const tag = document.createElement('div');

    tag.className = 'tag';

    tag.dataset.id = id;

    tag.innerHTML = `

        <span>${type === 'channel' ? '#' + getName(id, 'channel') : (type === 'role' ? '@' + getName(id, 'role') : id)}</span>

        <i class="fas fa-times" onclick="this.parentElement.remove(); markDirty();"></i>

    `;

    container.appendChild(tag);



    if (isNew) {

        markDirty();

    }

}



function setupBuilders() {

    // Dropdown listeners for tag adders

    document.getElementById('waiting-rooms-select').addEventListener('change', (e) => {

        if (e.target.value) {

            addTag('waiting-rooms-builder', e.target.value, 'channel', true);

            e.target.value = "";

        }

    });



    document.getElementById('thumbs-up-select').addEventListener('change', (e) => {

        if (e.target.value) {

            addTag('thumbs-up-builder', e.target.value, 'channel', true);

            e.target.value = "";

        }

    });

}



// --- SAVING ---



let saveInFlight = false;
let saveQueued = false;

async function saveConfig() {

    // Läuft bereits ein Save? Dann nach Abschluss erneut speichern (letzter Stand gewinnt)

    if (saveInFlight) { saveQueued = true; return; }

    saveInFlight = true;

    showAutosave('saving');

    try {

        const newMainConfig = { ...currentConfig }; // Clone main

        const newFiveMConfig = { ...currentFiveMConfig }; // Clone fivem



        // 1. Standard Inputs & Selects (nur innerhalb des Config-Formulars,
        //    sonst landen Login-Felder o.ä. in der Config)

        document.querySelectorAll('#config-form input:not([type="color"]):not([class*="-input"]), #config-form select.dynamic-select:not([id*="-select"])').forEach(el => {

            const key = el.name;

            if (!key) return;



            // Skip builder selects (handled separately)



            let val = el.value;

            // Only parse as Int if it looks like a small number (not an ID)

            if (el.type === 'number' || (el.tagName === 'SELECT' && !isNaN(parseInt(val)))) {

                if (val === "") {

                    val = null;

                } else if (val.length > 15) {

                    // Keep as string (ID)

                } else {

                    val = parseInt(val);

                }

            }



            // Decide where to put it

            if (key.startsWith('FIVEM_')) {

                newFiveMConfig[key] = val;

            } else {

                newMainConfig[key] = val;

            }

        });



        // ACCENT_COLOR hat die Klasse "color-input-number" und wird vom Selektor oben
        // ausgeschlossen -> explizit übernehmen

        const accentInput = document.getElementById('ACCENT_COLOR');

        if (accentInput && accentInput.value !== '' && !isNaN(parseInt(accentInput.value))) {

            newMainConfig.ACCENT_COLOR = parseInt(accentInput.value);

        }



        // Also capture generic select inputs that might not have class dynamic-select but have ID

        // Specifically for FiveM toggles

        const booleanSelects = ['FIVEM_WHITELIST_ENABLED', 'FIVEM_BANLIST_ENABLED', 'FIVEM_WHITELIST_ROLE_ENABLED'];

        booleanSelects.forEach(id => {

            const el = document.getElementById(id);

            if (el) {

                if (el.type === 'checkbox') {

                    newFiveMConfig[el.name] = el.checked;

                } else {

                    newFiveMConfig[el.name] = el.value === 'true';

                }

            }

        });



        // Textareas (Messages)

        const textAreas = ['FIVEM_WHITELIST_MESSAGE', 'FIVEM_BANLIST_MESSAGE', 'FIVEM_KICK_MESSAGE'];

        textAreas.forEach(id => {

            const el = document.getElementById(id);

            if (el) {

                newFiveMConfig[el.name] = el.value;

            }

        });





        // 2. Reconstruct Vote Channels

        const voteRows = document.querySelectorAll('#vote-channels-builder .builder-row');

        const voteChannels = {};

        voteRows.forEach(row => {

            const chanId = row.querySelector('select').value;

            const emojis = row.querySelector('input').value.split(',').map(s => s.trim()).filter(s => s);

            if (chanId) voteChannels[chanId] = emojis;

        });

        newMainConfig.VOTE_CHANNELS = voteChannels;



        // 3. Reconstruct Role Sync

        const syncRows = document.querySelectorAll('#role-sync-builder .builder-card');

        const roleSync = {};

        syncRows.forEach(row => {

            const targetId = row.querySelector('.target-role-select').value;

            if (targetId) {

                const sourceContainer = row.querySelector('.tag-builder');

                const sourceIds = Array.from(sourceContainer.querySelectorAll('.tag')).map(t => t.dataset.id);

                roleSync[targetId] = sourceIds;

            }

        });

        newMainConfig.ROLE_SYNC_MAPPING = roleSync;



        // 4. Reconstruct Ticket Types

        const ticketRows = document.querySelectorAll('#ticket-types-builder .builder-card');

        const ticketTypes = {};

        ticketRows.forEach(row => {

            const key = row.querySelector('.key-input').value;

            if (key) {

                // Harvest roles from the specific tag container in this row

                const rolesContainer = row.querySelector('.tag-builder');

                const roles = Array.from(rolesContainer.querySelectorAll('.tag')).map(t => t.dataset.id);



                ticketTypes[key] = {

                    label: row.querySelector('.label-input').value,

                    prefix: row.querySelector('.prefix-input').value,

                    roles: roles

                };

            }

        });

        newMainConfig.TICKET_TYPES = ticketTypes;



        // 5. Reconstruct Tags

        newMainConfig.WAITING_ROOMS = Array.from(document.querySelectorAll('#waiting-rooms-builder .tag'))

            .map(t => t.dataset.id);



        newMainConfig.THUMBS_UP_CHANNELS = Array.from(document.querySelectorAll('#thumbs-up-builder .tag'))

            .map(t => t.dataset.id);



        newMainConfig.TICKET_PERMANENT_ADMINS = Array.from(document.querySelectorAll('#ticket-admins-builder .tag'))

            .map(t => t.dataset.id);



        // FiveM Lists

        newFiveMConfig.FIVEM_WHITELIST = Array.from(document.querySelectorAll('#fivem-whitelist-builder .tag')).map(t => t.dataset.id);

        newFiveMConfig.FIVEM_BANLIST = Array.from(document.querySelectorAll('#fivem-banlist-builder .tag')).map(t => t.dataset.id);



        // Nur die Konfigurationen senden, für die der Nutzer Rechte hat

        // (verhindert 403-Fehler, wenn z.B. nur FiveM-Rechte vorhanden sind)

        const doMain = canSaveMainConfig();

        const doFivem = canSaveFivemConfig();



        const [mainRes, fivemRes] = await Promise.all([

            doMain ? fetchWithAuth(API_URL, { method: 'POST', body: JSON.stringify(newMainConfig) }) : Promise.resolve('skip'),

            doFivem ? fetchWithAuth(FIVEM_CONFIG_URL, { method: 'POST', body: JSON.stringify(newFiveMConfig) }) : Promise.resolve('skip')

        ]);



        // null = Session abgelaufen (fetchWithAuth hat 401 erkannt)

        if (mainRes === null || fivemRes === null) throw new Error('Session abgelaufen - bitte neu einloggen');



        // Lokale Kopien nur für tatsächlich gespeicherte Configs aktualisieren

        if (doMain) currentConfig = newMainConfig;

        if (doFivem) currentFiveMConfig = newFiveMConfig;



        hasUnsavedChanges = false;

        showAutosave('saved');



    } catch (error) {

        console.error(error);

        showAutosave('error');

    } finally {

        saveInFlight = false;

        // Während des Speicherns kam eine weitere Änderung -> erneut speichern

        if (saveQueued) {

            saveQueued = false;

            scheduleAutoSave();

        }

    }

}



// Helpers... (Navigation etc)

function setupNavigation() {

    navItems.forEach(item => {

        item.addEventListener('click', () => {

            const sectionId = item.dataset.section;

            if (!sectionId) return;

            navItems.forEach(nav => nav.classList.remove('active'));

            item.classList.add('active');

            sections.forEach(section => {

                section.classList.remove('active', 'fade-in');

                if (section.id === `section-${sectionId}`) {

                    section.classList.add('active');

                    void section.offsetWidth;

                    section.classList.add('fade-in');

                }

            });

            updateHeader(sectionId);

            updateSaveButtonVisibility();

            // Aktive Banns laden, wenn die FiveM-Einstellungen geöffnet werden

            if (sectionId === 'fivem-general') {

                loadBans();

            }

            // Jobs laden, wenn die Job-Verwaltung geöffnet wird

            if (sectionId === 'jobs-manage') {

                loadJobsManage();

            }

            if (sectionId === 'jobs-create') {

                loadJobsCreate();

            }

            // Live-Karte erst beim ersten Öffnen initialisieren (Leaflet braucht sichtbaren Container)

            if (sectionId === 'fivem-map') {

                initLivemap();

                setTimeout(() => {

                    if (livemap) {

                        livemap.invalidateSize();

                        updateLivemapMarkers(currentServerData);

                    }

                }, 60);

            }

        });

    });



    // Initial State for Save Button

    updateSaveButtonVisibility();

}



function updateHeader(sectionId) {

    const titles = {

        'dashboard': ['Dashboard', 'Willkommen zurück, Administrator'],

        'general': ['Allgemeines', 'Bot Identität & Verbindungen'],

        'channels': ['Kanäle', 'Wichtige Kanal-Zuweisungen'],

        'roles': ['Rollen', 'Sync & Auto-Roles'],

        'tickets': ['Ticket System', 'Support Konfiguration'],

        'reactions': ['Reaktionen', 'Emoji & Auto-Reacts'],

        'fivem-general': ['FiveM Server', 'Whitelist & Banlist Einstellungen'],
        'fivem-map': ['Live Karte', 'Spieler-Positionen in Echtzeit'],
        'fivem-console': ['FiveM Konsole', 'Live Server Logs & Rcon'],
        'jobs-manage': ['Jobs', 'ESX-Jobs & Mitarbeiter verwalten'],
        'jobs-create': ['Jobs verwalten', 'ESX-Jobs anlegen & bearbeiten'],
        'admins': ['Admin Accounts', 'Verwaltung der Web-Panel Zugänge'],
        'players': ['Spieler Übersicht', 'Live Daten & Historie']

    };

    if (titles[sectionId]) {

        pageTitle.textContent = titles[sectionId][0];

        pageSubtitle.textContent = titles[sectionId][1];

    }

}



function setupDropdowns() {

    dropdownHeaders.forEach(header => {

        header.addEventListener('click', () => header.parentElement.classList.toggle('open'));

    });

    // document.querySelector('.dropdown-menu')?.classList.add('open');

}



function setupColorPicker() {

    if (!colorInput) return;

    colorInput.addEventListener('input', () => {

        const valid = !isNaN(parseInt(colorInput.value));

        if (valid) {

            const hex = '#' + parseInt(colorInput.value).toString(16).padStart(6, '0');

            colorPreview.value = hex;

            colorPreviewBox.style.background = hex;

        }

    });

    colorPreview.addEventListener('input', () => {

        colorInput.value = parseInt(colorPreview.value.replace('#', ''), 16);

        colorPreviewBox.style.background = colorPreview.value;

    });

}



function setupPasswordToggle() {

    const toggle = document.querySelector('.toggle-password');

    const input = document.getElementById('TOKEN');

    if (toggle && input) {

        toggle.addEventListener('click', () => {

            const type = input.type === 'password' ? 'text' : 'password';

            input.type = type;

            toggle.classList.toggle('fa-eye');

            toggle.classList.toggle('fa-eye-slash');

        });

    }

}



function showLoading(show) {

    if (show) loadingOverlay.classList.remove('hidden');

    else setTimeout(() => loadingOverlay.classList.add('hidden'), 500);

}



function showToast(message, type = 'success') {

    const msgEl = document.getElementById('toast-message');

    const icon = toast.querySelector('i');

    msgEl.textContent = message;

    if (type === 'error') {

        toast.style.borderLeftColor = '#ff4444';

        icon.className = 'fas fa-exclamation-circle';

        icon.style.color = '#ff4444';

    } else {

        toast.style.borderLeftColor = '#00ff88';

        icon.className = 'fas fa-check-circle';

        icon.style.color = '#00ff88';

    }

    toast.classList.add('show');

    setTimeout(() => toast.classList.remove('show'), 3000);

}



// --- Player List Logic ---



function updatePlayerListPage(data) {

    const tableBody = document.getElementById('full-player-list-body');

    if (!tableBody) return; // Not on page or element missing



    if (!data.online) {

        tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Server Offline</td></tr>';

        return;

    }



    if (data.players.length === 0) {

        tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Keine Spieler online</td></tr>';

        return;

    }



    const canModerate = canEditPlayers();

    tableBody.innerHTML = data.players.map(p => `
        <tr onclick="showPlayerDetails('${p.id}')">
            <td style="font-family:monospace; color:#aaa; font-size:1.1rem;">${p.id}</td>
            <td>
                <div style="font-weight:600; color:#fff;">${escapeHtml(p.name)}</div>
                <div style="font-size:0.85rem; color:#888;">${escapeHtml(p.rp_name || '-')}</div>
            </td>
            <td><span style="color:#aaa;">${p.ping} ms</span></td>
            <td style="text-align:right;">
                ${canModerate ? `
                <button class="row-action kick" title="Kicken" onclick="event.stopPropagation(); openKickModal('${p.id}')"><i class="fas fa-door-open"></i></button>
                <button class="row-action ban" title="Bannen" onclick="event.stopPropagation(); openBanModal('${p.id}')"><i class="fas fa-gavel"></i></button>
                ` : ''}
            </td>
        </tr>
    `).join('');

}

// --- MODERATION (Ban / Kick) ---

let moderationContext = null; // { type, playerId, playerName, identifiers }

function openModeration(type, playerId) {
    const player = (currentServerData.players || []).find(p => p.id == playerId);
    if (!player) { showToast('Spieler nicht gefunden', 'error'); return; }

    moderationContext = {
        type: type,
        playerId: player.id,
        playerName: player.name || 'Unbekannt',
        identifiers: player.identifiers || []
    };

    document.getElementById('moderation-title').innerHTML = type === 'ban'
        ? '<i class="fas fa-gavel"></i> Spieler bannen'
        : '<i class="fas fa-door-open"></i> Spieler kicken';
    document.getElementById('moderation-player').value = `${player.name} (ID ${player.id})`;
    document.getElementById('moderation-reason').value = '';
    // Dauer-Zeile nur beim Bannen anzeigen
    document.getElementById('moderation-duration-row').style.display = type === 'ban' ? '' : 'none';

    const confirmBtn = document.getElementById('moderation-confirm');
    confirmBtn.textContent = type === 'ban' ? 'Bannen' : 'Kicken';
    confirmBtn.classList.toggle('btn-danger', true);

    document.getElementById('moderation-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('moderation-reason').focus(), 50);
}

function openBanModal(playerId) { openModeration('ban', playerId); }
function openKickModal(playerId) { openModeration('kick', playerId); }

function closeModerationModal() {
    document.getElementById('moderation-modal').classList.add('hidden');
    moderationContext = null;
}

async function submitModeration() {
    if (!moderationContext) return;
    const ctx = moderationContext;
    const reason = document.getElementById('moderation-reason').value.trim();
    if (!reason) { showToast('Bitte einen Grund angeben', 'error'); return; }

    const params = { reason };
    if (ctx.type === 'ban') {
        const val = parseInt(document.getElementById('moderation-duration').value);
        const unit = parseInt(document.getElementById('moderation-duration-unit').value);
        // unit 0 = permanent; sonst Wert * Einheit (Sekunden)
        params.duration = (unit === 0 || isNaN(val) || val <= 0) ? 0 : val * unit;
        params.identifiers = ctx.identifiers;
        params.name = ctx.playerName;
    }

    try {
        const res = await fetchWithAuth('/api/fivem/player_action', {
            method: 'POST',
            body: JSON.stringify({
                action: ctx.type,
                id: ctx.playerId,
                identifier: (ctx.identifiers || []).find(i => i.startsWith('license:')) || (ctx.identifiers || [])[0],
                params: params
            })
        });
        if (res) {
            showToast(ctx.type === 'ban' ? 'Spieler gebannt' : 'Spieler gekickt');
            closeModerationModal();
            // Wenn das Spieler-Popup desselben Spielers offen ist, schließen
            if (modalState && String(modalState.playerId) === String(ctx.playerId)) closePlayerModal();
        }
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}

// --- BANN-VERWALTUNG (Aktive Banns in den FiveM-Einstellungen) ---

function formatBanExpiry(ban) {
    if (!ban.expires) return 'Permanent';
    const remaining = ban.expires * 1000 - Date.now();
    if (remaining <= 0) return 'Abgelaufen';
    const d = new Date(ban.expires * 1000);
    const days = Math.floor(remaining / 86400000);
    const hours = Math.floor((remaining % 86400000) / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    let left = days > 0 ? `${days}d ${hours}h` : (hours > 0 ? `${hours}h ${mins}m` : `${mins}m`);
    return `${d.toLocaleString('de-DE')} (noch ${left})`;
}

async function loadBans() {
    const container = document.getElementById('bans-list');
    if (!container) return;
    container.innerHTML = '<div class="empty-state">Lade Banns…</div>';
    try {
        const res = await fetchWithAuth('/api/fivem/bans');
        if (!res) return;
        const bans = await res.json();
        if (!Array.isArray(bans) || bans.length === 0) {
            container.innerHTML = '<div class="empty-state">Keine aktiven Banns.</div>';
            return;
        }
        container.innerHTML = bans.map(b => `
            <div class="ban-row">
                <div class="ban-info">
                    <div class="ban-name">${escapeHtml(b.name || 'Unbekannt')}</div>
                    <div class="ban-meta">
                        <span><i class="fas fa-comment"></i> ${escapeHtml(b.reason || 'Kein Grund')}</span>
                        <span><i class="fas fa-clock"></i> ${escapeHtml(formatBanExpiry(b))}</span>
                        <span><i class="fas fa-user-shield"></i> ${escapeHtml(b.by || '-')}</span>
                    </div>
                    <div class="ban-ids">${(b.identifiers || []).map(i => escapeHtml(i)).join(', ')}</div>
                </div>
                <button class="small-btn" onclick="unbanPlayer('${escapeHtml(b.id)}')">
                    <i class="fas fa-unlock"></i> Entbannen</button>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = `<div class="empty-state" style="color:#ff5468;">Fehler: ${escapeHtml(e.message)}</div>`;
    }
}

async function unbanPlayer(banId) {
    if (!confirm('Diesen Bann wirklich aufheben?')) return;
    try {
        const res = await fetchWithAuth('/api/fivem/unban', {
            method: 'POST',
            body: JSON.stringify({ id: banId })
        });
        if (res) {
            showToast('Bann aufgehoben');
            loadBans();
        }
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}

// --- FIVEM JOBS: VERWALTUNG (Phase 1) ---
let jobsManageCache = [];
let jobEmployeesCache = {}; // jobName -> [employees]
const jobEmployeesLoading = new Set(); // läuft gerade eine Abfrage?
const jobEmployeesError = {}; // jobName -> Fehlertext (statt endlosem "Lade…")
const expandedJobs = new Set();

async function loadJobsManage(force) {
    const container = document.getElementById('jobs-manage-list');
    if (!container) return;
    const search = document.getElementById('jobs-search');
    if (search && !search._bound) { search.oninput = () => renderJobsManage(); search._bound = true; }

    if (force || jobsManageCache.length === 0) {
        container.innerHTML = '<div class="empty-state">Lade Jobs…</div>';
        try {
            const res = await fetchWithAuth('/api/fivem/jobs');
            if (!res) return;
            const jobs = await res.json();
            jobsManageCache = Array.isArray(jobs) ? jobs : [];
            if (force) { jobEmployeesCache = {}; Object.keys(jobEmployeesError).forEach(k => delete jobEmployeesError[k]); } // bei manuellem Refresh neu laden
        } catch (e) {
            container.innerHTML = `<div class="empty-state" style="color:#ff5468;">Fehler: ${escapeHtml(e.message)}</div>`;
            return;
        }
    }
    renderJobsManage();
}

function renderJobsManage() {
    const container = document.getElementById('jobs-manage-list');
    if (!container) return;
    const q = (document.getElementById('jobs-search')?.value || '').trim().toLowerCase();
    let jobs = jobsManageCache;
    if (q) jobs = jobs.filter(j => (j.label || '').toLowerCase().includes(q) || (j.name || '').toLowerCase().includes(q));
    if (jobs.length === 0) {
        container.innerHTML = '<div class="empty-state">Keine Jobs gefunden.</div>';
        return;
    }
    container.innerHTML = jobs.map(j => {
        const idx = jobsManageCache.indexOf(j);
        const open = expandedJobs.has(j.name);
        const gradeCount = (j.grades || []).length;
        return `
        <div class="job-card">
            <div class="job-head" onclick="toggleJobCard('${safeAttr(j.name)}')">
                <div class="job-titles">
                    <span class="job-label">${escapeHtml(j.label || j.name)}</span>
                    <span class="job-name">${escapeHtml(j.name)}</span>
                </div>
                <div class="job-head-right">
                    <span class="job-grade-count">${gradeCount} Grade${gradeCount === 1 ? '' : 's'}</span>
                    <i class="fas fa-chevron-down job-chevron ${open ? 'open' : ''}"></i>
                </div>
            </div>
            <div class="job-body ${open ? '' : 'hidden'}" id="job-body-${idx}">
                ${open ? renderJobBody(j, idx) : ''}
            </div>
        </div>`;
    }).join('');

    // Mitarbeiter für aufgeklappte Jobs sicherstellen (verhindert endloses "Lade…"
    // nach einem Neu-Rendern, z.B. durch Suche oder Aufklappen eines anderen Jobs)
    expandedJobs.forEach(jobName => {
        if (jobEmployeesCache[jobName]) renderJobEmployees(jobName);
        else ensureJobEmployees(jobName);
    });
}

function renderJobBody(job, idx) {
    const grades = [...(job.grades || [])].sort((a, b) => a.grade - b.grade);
    const gradeRows = grades.map(g => `
        <tr><td>${g.grade}</td><td>${escapeHtml(g.label || g.name || '')}</td><td>${escapeHtml(g.name || '')}</td><td style="text-align:right;">${(Number(g.salary) || 0).toLocaleString('de-DE')} $</td></tr>
    `).join('');
    const gradeOptions = grades.map(g => `<option value="${g.grade}">${escapeHtml(g.label || g.name)} (${g.grade})</option>`).join('');
    const onlinePlayers = (currentServerData.players || []);
    const hireOptions = onlinePlayers.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (ID ${p.id})</option>`).join('');

    return `
        <h4 class="job-sub">Grades</h4>
        <div class="table-responsive">
            <table class="player-table">
                <thead><tr><th style="width:60px;">Grade</th><th>Label</th><th>Name</th><th style="text-align:right;">Gehalt</th></tr></thead>
                <tbody>${gradeRows || '<tr><td colspan="4" class="empty-state">Keine Grades</td></tr>'}</tbody>
            </table>
        </div>
        <h4 class="job-sub">Mitarbeiter einstellen</h4>
        <div class="hire-row">
            <select id="hire-player-${idx}" class="select-input">${hireOptions || '<option value="">Keine Spieler online</option>'}</select>
            <select id="hire-grade-${idx}" class="select-input">${gradeOptions}</select>
            <button type="button" class="btn-hire" onclick="hireToJob('${safeAttr(job.name)}', ${idx})"><i class="fas fa-user-plus"></i> Einstellen</button>
        </div>
        <h4 class="job-sub">Mitarbeiter</h4>
        <div id="job-employees-${idx}" class="job-employees"><div class="empty-state">Lade Mitarbeiter…</div></div>
    `;
}

function toggleJobCard(jobName) {
    if (expandedJobs.has(jobName)) expandedJobs.delete(jobName);
    else expandedJobs.add(jobName);
    renderJobsManage(); // kümmert sich auch um das Laden der Mitarbeiter
}

// Stößt die Mitarbeiter-Abfrage genau EINMAL an und zeigt danach Daten/Fehler
function ensureJobEmployees(jobName) {
    const idx = jobsManageCache.findIndex(j => j.name === jobName);
    if (idx < 0) return;
    const el = document.getElementById('job-employees-' + idx);

    if (jobEmployeesError[jobName]) {
        if (el) el.innerHTML = `<div class="empty-state" style="color:#ffaa00;">${escapeHtml(jobEmployeesError[jobName])}
            <br><button type="button" class="btn-refresh" style="margin-top:10px;" onclick="retryJobEmployees('${safeAttr(jobName)}')"><i class="fas fa-sync-alt"></i> Erneut versuchen</button></div>`;
        return;
    }
    if (jobEmployeesLoading.has(jobName)) {
        if (el) el.innerHTML = '<div class="empty-state">Lade Mitarbeiter…</div>';
        return;
    }
    jobEmployeesLoading.add(jobName);
    if (el) el.innerHTML = '<div class="empty-state">Lade Mitarbeiter…</div>';

    requestJobEmployees(jobName).then(employees => {
        jobEmployeesLoading.delete(jobName);
        if (employees === null) {
            jobEmployeesError[jobName] = 'Keine Antwort vom Game-Server (läuft die Resource raze_adminpanel?).';
        } else {
            delete jobEmployeesError[jobName];
            jobEmployeesCache[jobName] = employees;
        }
        // nur rendern, wenn der Job noch aufgeklappt ist
        if (expandedJobs.has(jobName)) {
            if (jobEmployeesCache[jobName]) renderJobEmployees(jobName);
            else ensureJobEmployees(jobName); // zeigt den Fehler-Block
        }
    });
}

function retryJobEmployees(jobName) {
    delete jobEmployeesError[jobName];
    delete jobEmployeesCache[jobName];
    ensureJobEmployees(jobName);
}

async function requestJobEmployees(jobName) {
    try {
        const res = await fetchWithAuth('/api/fivem/job_employees_request', { method: 'POST', body: JSON.stringify({ job: jobName }) });
        if (!res) return null;
        const data = await res.json();
        const requestId = data.request_id;
        if (!requestId) return null;
        // Schnell pollen (500ms), bis ~8s; Game-Server pollt selbst alle 2s
        for (let i = 0; i < 16; i++) {
            await new Promise(r => setTimeout(r, 500));
            const poll = await fetchWithAuth('/api/fivem/job_employees?id=' + encodeURIComponent(requestId));
            if (!poll) return null;
            const result = await poll.json();
            if (result.status === 'ready') return (result.data && result.data.employees) || [];
        }
    } catch (e) { console.warn('job employees', e); }
    return null;
}

function renderJobEmployees(jobName) {
    const idx = jobsManageCache.findIndex(j => j.name === jobName);
    if (idx < 0) return;
    const el = document.getElementById('job-employees-' + idx);
    if (!el) return;
    const grades = [...(jobsManageCache[idx].grades || [])].sort((a, b) => a.grade - b.grade);
    const employees = jobEmployeesCache[jobName] || [];
    if (employees.length === 0) { el.innerHTML = '<div class="empty-state">Keine Mitarbeiter.</div>'; return; }
    el.innerHTML = employees.map(emp => {
        const gradeOptions = grades.map(g => `<option value="${g.grade}" ${g.grade === emp.grade ? 'selected' : ''}>${escapeHtml(g.label || g.name)} (${g.grade})</option>`).join('');
        return `
        <div class="employee-row">
            <div class="employee-info">
                <span class="employee-dot ${emp.online ? 'online' : 'offline'}"></span>
                <span class="employee-name">${escapeHtml(emp.name || 'Unbekannt')}</span>
                <span class="employee-id">${escapeHtml(emp.identifier || '')}</span>
            </div>
            <div class="employee-actions">
                <select class="select-input" title="Rang ändern" onchange="setEmployeeGrade('${safeAttr(jobName)}','${safeAttr(emp.identifier)}', ${emp.server_id != null ? emp.server_id : 'null'}, this.value)">${gradeOptions}</select>
                <button type="button" class="row-action ban" title="Feuern" onclick="fireEmployee('${safeAttr(jobName)}','${safeAttr(emp.identifier)}', ${emp.server_id != null ? emp.server_id : 'null'})"><i class="fas fa-user-slash"></i></button>
            </div>
        </div>`;
    }).join('');
}

async function postJobAction(payload) {
    try {
        const res = await fetchWithAuth('/api/fivem/job_action', { method: 'POST', body: JSON.stringify(payload) });
        return !!res;
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); return false; }
}

async function setEmployeeGrade(jobName, identifier, serverId, gradeVal) {
    const grade = parseInt(gradeVal);
    const ok = await postJobAction({ action: 'promote', job: jobName, grade, id: serverId, identifier });
    if (ok) {
        showToast('Rang gesetzt – wird übernommen');
        const emp = (jobEmployeesCache[jobName] || []).find(e => e.identifier === identifier);
        if (emp) emp.grade = grade;
    }
}

async function fireEmployee(jobName, identifier, serverId) {
    const emp = (jobEmployeesCache[jobName] || []).find(e => e.identifier === identifier);
    const name = emp ? emp.name : 'diesen Mitarbeiter';
    if (!confirm(`${name} wirklich feuern (→ unemployed)?`)) return;
    const ok = await postJobAction({ action: 'fire', job: 'unemployed', grade: 0, id: serverId, identifier });
    if (ok) {
        showToast('Mitarbeiter gefeuert');
        jobEmployeesCache[jobName] = (jobEmployeesCache[jobName] || []).filter(e => e.identifier !== identifier);
        renderJobEmployees(jobName);
    }
}

async function hireToJob(jobName, idx) {
    const playerSel = document.getElementById('hire-player-' + idx);
    const gradeSel = document.getElementById('hire-grade-' + idx);
    if (!playerSel || !playerSel.value) { showToast('Bitte einen Online-Spieler wählen', 'error'); return; }
    const pid = parseInt(playerSel.value);
    const grade = parseInt(gradeSel ? gradeSel.value : '0') || 0;
    const player = (currentServerData.players || []).find(p => p.id == pid);
    const identifier = player ? ((player.identifiers || []).find(i => i.startsWith('license:')) || (player.identifiers || [])[0]) : null;
    const ok = await postJobAction({ action: 'hire', job: jobName, grade, id: pid, identifier });
    if (ok) {
        showToast('Mitarbeiter eingestellt – wird übernommen');
        setTimeout(() => { delete jobEmployeesCache[jobName]; delete jobEmployeesError[jobName]; ensureJobEmployees(jobName); }, 1500);
    }
}

// --- FIVEM JOBS: CREATOR (Phase 2) ---
const LOCATION_TYPES = [
    { value: 'storage', label: 'Item-Lager (ox_inventory Stash)' },
    { value: 'armory', label: 'Waffenlager (ox_inventory Stash)' },
    { value: 'garage', label: 'Garage (Fahrzeuge ein-/ausparken)' },
    { value: 'cloakroom', label: 'Umkleide' }
];

// Gängige GTA-Blip-Farben (Palette-Index)
const BLIP_COLORS = [
    { v: 0, label: 'Weiß' }, { v: 1, label: 'Rot' }, { v: 2, label: 'Grün' },
    { v: 3, label: 'Blau' }, { v: 5, label: 'Gelb' }, { v: 17, label: 'Orange' },
    { v: 8, label: 'Pink' }, { v: 7, label: 'Lila' }, { v: 27, label: 'Hellblau' },
    { v: 25, label: 'Dunkelgrün' }, { v: 38, label: 'Dunkelblau' }, { v: 47, label: 'Türkis' },
    { v: 4, label: 'Hellrot' }, { v: 46, label: 'Dunkelrot' }, { v: 40, label: 'Grau' }
];
const F5_FUNCTIONS = [
    { key: 'cuff', label: 'Fesseln' },
    { key: 'uncuff', label: 'Entfesseln' },
    { key: 'drag', label: 'Draggen' },
    { key: 'vehicle', label: 'In/aus Auto setzen' },
    { key: 'search', label: 'Durchsuchen' },
    { key: 'idcard', label: 'Ausweis ansehen' },
    { key: 'licenses', label: 'Lizenzen ansehen' }
];

let jobsCreateCache = [];   // ESX-Jobs (name,label,grades)
let jobDataCache = {};      // job_name -> extra (locations, blips, f5, color)

async function loadJobsCreate(force) {
    const container = document.getElementById('jobs-create-list');
    if (!container) return;
    const search = document.getElementById('jobs-create-search');
    if (search && !search._bound) { search.oninput = () => renderJobsCreateList(); search._bound = true; }

    if (force || jobsCreateCache.length === 0) {
        container.innerHTML = '<div class="empty-state">Lade Jobs…</div>';
        try {
            const [jobsRes, dataRes] = await Promise.all([
                fetchWithAuth('/api/fivem/jobs'),
                fetchWithAuth('/api/fivem/job_data').catch(() => null)
            ]);
            if (!jobsRes) return;
            jobsCreateCache = await jobsRes.json();
            jobDataCache = dataRes ? (await dataRes.json()) : {};
        } catch (e) {
            container.innerHTML = `<div class="empty-state" style="color:#ff5468;">Fehler: ${escapeHtml(e.message)}</div>`;
            return;
        }
    }
    renderJobsCreateList();
}

function renderJobsCreateList() {
    const container = document.getElementById('jobs-create-list');
    if (!container) return;
    const q = (document.getElementById('jobs-create-search')?.value || '').trim().toLowerCase();
    let jobs = jobsCreateCache.filter(j => j.name !== 'unemployed');
    if (q) jobs = jobs.filter(j => (j.label || '').toLowerCase().includes(q) || (j.name || '').toLowerCase().includes(q));
    if (jobs.length === 0) {
        container.innerHTML = '<div class="empty-state">Keine Jobs. Lege oben einen neuen Job an.</div>';
        return;
    }
    container.innerHTML = jobs.map(j => {
        const extra = jobDataCache[j.name] || {};
        const locCount = (extra.locations || []).length;
        return `
        <div class="job-card">
            <div class="job-head" style="cursor:default;">
                <div class="job-titles">
                    <span class="job-label">${escapeHtml(j.label || j.name)}</span>
                    <span class="job-name">${escapeHtml(j.name)}</span>
                </div>
                <div class="job-head-right">
                    <span class="job-grade-count">${(j.grades || []).length} Grades · ${locCount} Location${locCount === 1 ? '' : 's'}</span>
                    <button type="button" class="btn-refresh" onclick="openJobEditor('${safeAttr(j.name)}')"><i class="fas fa-edit"></i> Bearbeiten</button>
                </div>
            </div>
        </div>`;
    }).join('');
}

function openJobEditor(name) {
    const isEdit = !!name;
    const job = isEdit ? jobsCreateCache.find(j => j.name === name) : null;
    const extra = (isEdit && jobDataCache[name]) ? jobDataCache[name] : {};
    document.getElementById('job-editor-title').innerHTML = isEdit
        ? `<i class="fas fa-edit"></i> Job bearbeiten: ${escapeHtml(name)}`
        : '<i class="fas fa-briefcase"></i> Neuer Job';
    document.getElementById('job-editor-delete').style.display = isEdit ? '' : 'none';

    const f5 = extra.f5 || {};
    const f5Html = F5_FUNCTIONS.map(f =>
        `<label class="perm-label" style="flex:1; min-width:150px;"><span>${f.label}</span>
            <input type="checkbox" class="je-f5" data-f5="${f.key}" ${f5[f.key] ? 'checked' : ''}></label>`
    ).join('');

    const jobColor = extra.color || '#ff4e00';

    document.getElementById('job-editor-body').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>Job-Name (Schlüssel, a-z/0-9/_)</label>
                <input type="text" id="je-name" value="${isEdit ? escapeHtml(name) : ''}" ${isEdit ? 'disabled' : ''} placeholder="z.B. mechanic">
            </div>
            <div class="form-group">
                <label>Label (Anzeigename)</label>
                <input type="text" id="je-label" value="${escapeHtml(job ? (job.label || '') : '')}" placeholder="z.B. Mechaniker">
            </div>
            <div class="form-group" style="flex:0 0 auto;">
                <label>Marker-Farbe</label>
                <input type="color" id="je-color" value="${escapeHtml(jobColor)}" title="Farbe der 3D-Marker (Lager, Umkleide, …)">
                <label class="perm-label" style="margin-top:6px; gap:6px;">
                    <span>Angepasste Marker Farbe (ZSX UI)</span>
                    <input type="checkbox" id="je-zsx-color" ${extra.use_zsx_color ? 'checked' : ''}
                        title="Nutzt exports['ZSX_UIV2']:GetColor() für die Marker-Farbe">
                </label>
            </div>
        </div>

        <h4 class="job-sub">Grades / Ränge</h4>
        <div id="je-grades"></div>
        <button type="button" class="btn-refresh" onclick="addGradeRow()"><i class="fas fa-plus"></i> Grade</button>

        <h4 class="job-sub">Locations</h4>
        <div id="je-locations"></div>
        <button type="button" class="btn-refresh" onclick="addLocationRow()"><i class="fas fa-plus"></i> Location</button>

        <h4 class="job-sub">Karten-Blips</h4>
        <div id="je-blips"></div>
        <button type="button" class="btn-refresh" onclick="addBlipRow()"><i class="fas fa-plus"></i> Blip</button>

        <h4 class="job-sub">F5-Menü Funktionen (Phase 3)</h4>
        <div class="perm-grid" style="flex-direction:row; flex-wrap:wrap;">${f5Html}</div>
    `;

    // Grades befüllen
    const grades = (job && job.grades && job.grades.length) ? job.grades : [{ grade: 0, name: 'recruit', label: 'Mitarbeiter', salary: 0 }];
    grades.forEach(g => addGradeRow(g));
    // Locations & Blips befüllen
    (extra.locations || []).forEach(l => addLocationRow(l));
    (extra.blips || []).forEach(b => addBlipRow(b));

    document.getElementById('job-editor-modal').classList.remove('hidden');
}

function closeJobEditor() {
    document.getElementById('job-editor-modal').classList.add('hidden');
}

function addGradeRow(g) {
    g = g || { grade: '', name: '', label: '', salary: 0 };
    const wrap = document.getElementById('je-grades');
    const row = document.createElement('div');
    row.className = 'je-grade-row builder-row';
    row.innerHTML = `
        <input type="number" class="je-g-grade" placeholder="#" value="${g.grade !== '' ? g.grade : ''}" style="width:64px;" title="Grade-Nummer">
        <input type="text" class="je-g-name" placeholder="name (key)" value="${escapeHtml(g.name || '')}">
        <input type="text" class="je-g-label" placeholder="Label" value="${escapeHtml(g.label || '')}">
        <input type="number" class="je-g-salary" placeholder="Gehalt" value="${Number(g.salary) || 0}" style="width:110px;" title="Gehalt">
        <button type="button" class="del-btn" onclick="this.closest('.je-grade-row').remove()"><i class="fas fa-trash"></i></button>
    `;
    wrap.appendChild(row);
}

function locationExtraFields(l) {
    const t = l.type || 'storage';
    if (t === 'storage' || t === 'armory') {
        return `
        <div class="form-group-small"><label>Slots</label><input type="number" class="je-l-slots" value="${Number(l.slots) || 50}"></div>
        <div class="form-group-small"><label>Max. Gewicht (kg)</label><input type="number" class="je-l-weight" value="${Number(l.weight) || 100}"></div>`;
    }
    if (t === 'garage') {
        const vehText = (l.vehicles || []).map(v => `${v.model},${v.label || v.model}${v.price != null ? ',' + v.price : ''}`).join('\n');
        return `
        <div class="form-group-small full"><label>Fahrzeuge zum Ausparken (eine Zeile je Fahrzeug: <code>model,Label,Preis</code>)</label>
            <textarea class="je-l-vehicles" rows="3" placeholder="towtruck,Abschlepper,0">${escapeHtml(vehText)}</textarea></div>`;
    }
    return '';
}

function addLocationRow(l) {
    l = l || { type: 'storage', label: '', coords: {}, job_only: true };
    const wrap = document.getElementById('je-locations');
    const row = document.createElement('div');
    row.className = 'je-loc-row builder-card';
    const c = l.coords || {};
    const typeOpts = LOCATION_TYPES.map(t => `<option value="${t.value}" ${t.value === (l.type || 'storage') ? 'selected' : ''}>${t.label}</option>`).join('');
    row.innerHTML = `
        <div class="row-header">
            <select class="je-l-type select-input" onchange="onLocTypeChange(this)">${typeOpts}</select>
            <input type="text" class="je-l-label" placeholder="Bezeichnung (z.B. Hauptlager)" value="${escapeHtml(l.label || '')}">
            <button type="button" class="del-btn" onclick="this.closest('.je-loc-row').remove()"><i class="fas fa-trash"></i></button>
        </div>
        <div class="row-body">
            <div class="form-group-small"><label>X</label><input type="number" step="0.01" class="je-l-x" value="${c.x != null ? c.x : ''}"></div>
            <div class="form-group-small"><label>Y</label><input type="number" step="0.01" class="je-l-y" value="${c.y != null ? c.y : ''}"></div>
            <div class="form-group-small"><label>Z</label><input type="number" step="0.01" class="je-l-z" value="${c.z != null ? c.z : ''}"></div>
            <div class="form-group-small"><label>Heading</label><input type="number" step="0.01" class="je-l-w" value="${c.w != null ? c.w : ''}"></div>
            <div class="form-group-small full" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <button type="button" class="small-btn" onclick="captureJobLocation(this)"><i class="fas fa-map-marker-alt"></i> Aktuelle Position übernehmen</button>
                <label class="perm-label" style="flex:0;"><span>Nur für diesen Job</span><input type="checkbox" class="je-l-jobonly" ${l.job_only === false ? '' : 'checked'}></label>
            </div>
            <div class="je-l-extra full">${locationExtraFields(l)}</div>
        </div>
    `;
    wrap.appendChild(row);
}

function onLocTypeChange(sel) {
    const row = sel.closest('.je-loc-row');
    const extra = row.querySelector('.je-l-extra');
    extra.innerHTML = locationExtraFields({ type: sel.value });
}

async function fetchCapturedCoords() {
    const res = await fetchWithAuth('/api/fivem/job_location');
    if (!res) return null;
    const data = await res.json();
    if (!data.coords) {
        showToast('Keine frische Position. Führe im Spiel /setjobloc aus.', 'error');
        return null;
    }
    return data.coords;
}

async function captureJobLocation(btn) {
    const row = btn.closest('.je-loc-row');
    try {
        const c = await fetchCapturedCoords();
        if (!c) return;
        row.querySelector('.je-l-x').value = c.x ?? '';
        row.querySelector('.je-l-y').value = c.y ?? '';
        row.querySelector('.je-l-z').value = c.z ?? '';
        row.querySelector('.je-l-w').value = c.w ?? '';
        showToast('Position übernommen');
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

async function captureBlipLocation(btn) {
    const row = btn.closest('.je-blip-row');
    try {
        const c = await fetchCapturedCoords();
        if (!c) return;
        row.querySelector('.je-b-x').value = c.x ?? '';
        row.querySelector('.je-b-y').value = c.y ?? '';
        row.querySelector('.je-b-z').value = c.z ?? '';
        showToast('Position übernommen');
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

function addBlipRow(b) {
    b = b || { sprite: 1, name: '', color: 0, scale: 0.8, coords: {}, visibility: 'all' };
    const wrap = document.getElementById('je-blips');
    const c = b.coords || {};
    const row = document.createElement('div');
    row.className = 'je-blip-row builder-card';
    const colorOpts = BLIP_COLORS.map(co => `<option value="${co.v}" ${co.v === (b.color || 0) ? 'selected' : ''}>${co.label} (${co.v})</option>`).join('');
    row.innerHTML = `
        <div class="row-header">
            <input type="text" class="je-b-name" placeholder="Blip-Name (z.B. Polizei)" value="${escapeHtml(b.name || '')}">
            <button type="button" class="del-btn" onclick="this.closest('.je-blip-row').remove()"><i class="fas fa-trash"></i></button>
        </div>
        <div class="row-body">
            <div class="form-group-small"><label>X</label><input type="number" step="0.01" class="je-b-x" value="${c.x != null ? c.x : ''}"></div>
            <div class="form-group-small"><label>Y</label><input type="number" step="0.01" class="je-b-y" value="${c.y != null ? c.y : ''}"></div>
            <div class="form-group-small"><label>Z</label><input type="number" step="0.01" class="je-b-z" value="${c.z != null ? c.z : ''}"></div>
            <div class="form-group-small"><label>Sprite (Icon-Nr.)</label><input type="number" class="je-b-sprite" value="${Number(b.sprite) || 1}" title="GTA Blip-Sprite-Nummer"></div>
            <div class="form-group-small"><label>Farbe</label><select class="je-b-color select-input">${colorOpts}</select></div>
            <div class="form-group-small"><label>Größe</label><input type="number" step="0.1" class="je-b-scale" value="${Number(b.scale) || 0.8}"></div>
            <div class="form-group-small"><label>Sichtbar für</label>
                <select class="je-b-vis select-input">
                    <option value="all" ${(b.visibility || 'all') === 'all' ? 'selected' : ''}>Alle Spieler</option>
                    <option value="job" ${b.visibility === 'job' ? 'selected' : ''}>Nur Mitarbeiter</option>
                </select>
            </div>
            <div class="form-group-small full">
                <button type="button" class="small-btn" onclick="captureBlipLocation(this)"><i class="fas fa-map-marker-alt"></i> Aktuelle Position übernehmen</button>
            </div>
        </div>
    `;
    wrap.appendChild(row);
}

function harvestJobEditor() {
    const name = (document.getElementById('je-name').value || '').trim().toLowerCase();
    const label = (document.getElementById('je-label').value || '').trim();

    const grades = [];
    document.querySelectorAll('#je-grades .je-grade-row').forEach(r => {
        const grade = parseInt(r.querySelector('.je-g-grade').value);
        if (isNaN(grade)) return;
        grades.push({
            grade,
            name: (r.querySelector('.je-g-name').value || ('grade' + grade)).trim(),
            label: (r.querySelector('.je-g-label').value || ('Grade ' + grade)).trim(),
            salary: parseInt(r.querySelector('.je-g-salary').value) || 0
        });
    });

    const locations = [];
    document.querySelectorAll('#je-locations .je-loc-row').forEach(r => {
        const type = r.querySelector('.je-l-type').value;
        const loc = {
            type,
            label: (r.querySelector('.je-l-label').value || '').trim(),
            coords: {
                x: parseFloat(r.querySelector('.je-l-x').value) || 0,
                y: parseFloat(r.querySelector('.je-l-y').value) || 0,
                z: parseFloat(r.querySelector('.je-l-z').value) || 0,
                w: parseFloat(r.querySelector('.je-l-w').value) || 0
            },
            job_only: r.querySelector('.je-l-jobonly').checked
        };
        if (type === 'storage' || type === 'armory') {
            loc.slots = parseInt(r.querySelector('.je-l-slots')?.value) || 50;
            loc.weight = parseInt(r.querySelector('.je-l-weight')?.value) || 100;
        } else if (type === 'garage') {
            loc.vehicles = (r.querySelector('.je-l-vehicles')?.value || '').split('\n').map(line => {
                const p = line.split(',').map(s => s.trim());
                if (!p[0]) return null;
                return { model: p[0], label: p[1] || p[0], price: p[2] != null ? (parseInt(p[2]) || 0) : 0 };
            }).filter(Boolean);
        }
        locations.push(loc);
    });

    const blips = [];
    document.querySelectorAll('#je-blips .je-blip-row').forEach(r => {
        blips.push({
            name: (r.querySelector('.je-b-name').value || '').trim(),
            coords: {
                x: parseFloat(r.querySelector('.je-b-x').value) || 0,
                y: parseFloat(r.querySelector('.je-b-y').value) || 0,
                z: parseFloat(r.querySelector('.je-b-z').value) || 0
            },
            sprite: parseInt(r.querySelector('.je-b-sprite').value) || 1,
            color: parseInt(r.querySelector('.je-b-color').value) || 0,
            scale: parseFloat(r.querySelector('.je-b-scale').value) || 0.8,
            visibility: r.querySelector('.je-b-vis').value
        });
    });

    const f5 = {};
    document.querySelectorAll('#job-editor-body .je-f5').forEach(cb => { f5[cb.dataset.f5] = cb.checked; });
    const color = document.getElementById('je-color').value || '#ff4e00';
    const use_zsx_color = document.getElementById('je-zsx-color').checked;

    return { name, label: label || name, grades, extra: { locations, blips, f5, color, use_zsx_color } };
}

async function saveJobFromEditor() {
    const payload = harvestJobEditor();
    if (!/^[a-z0-9_]{1,50}$/.test(payload.name)) {
        showToast('Ungültiger Job-Name (nur a-z, 0-9, _)', 'error');
        return;
    }
    try {
        const res = await fetchWithAuth('/api/fivem/job_save', { method: 'POST', body: JSON.stringify(payload) });
        if (res) {
            showToast('Job gespeichert – wird auf dem Server angelegt');
            closeJobEditor();
            setTimeout(() => loadJobsCreate(true), 1500);
        }
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}

async function deleteJobFromEditor() {
    const name = (document.getElementById('je-name').value || '').trim().toLowerCase();
    if (!name) return;
    if (!confirm(`Job "${name}" wirklich löschen? Mitarbeiter werden dadurch jobless.`)) return;
    try {
        const res = await fetchWithAuth('/api/fivem/job_delete', { method: 'POST', body: JSON.stringify({ name }) });
        if (res) {
            showToast('Job gelöscht');
            closeJobEditor();
            setTimeout(() => loadJobsCreate(true), 1500);
        }
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}



// --- MODAL LOGIC (Spieler-Editor) ---

let modalState = null; // { playerId, identifier, isOnline, editing, player }
let serverJobs = [];

function canEditPlayers() {
    return userPermissions.includes('manage_players') || userPermissions.includes('all');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function safeItemName(name) {
    // Spawnnamen sind alphanumerisch - alles andere entfernen (sicher für onclick-Attribute)
    return String(name || '').replace(/[^\w\-:]/g, '');
}

async function fetchJobs() {
    try {
        const res = await fetchWithAuth('/api/fivem/jobs');
        if (res) {
            const data = await res.json();
            if (Array.isArray(data)) serverJobs = data;
        }
    } catch (e) {
        console.warn('Jobs fetch failed', e);
    }
}

function showPlayerDetails(playerId) {
    const player = (currentServerData.players || []).find(p => p.id == playerId);
    if (!player) return;

    const identifiers = player.identifiers || [];
    modalState = {
        playerId: player.id,
        identifier: identifiers.find(i => i.startsWith('license:')) || identifiers[0] || null,
        isOnline: true,
        editing: null,
        player: player
    };

    if (serverJobs.length === 0 && canEditPlayers()) fetchJobs();

    renderPlayerModal(player);
    document.getElementById('player-modal').classList.remove('hidden');
}

function refreshPlayerModal() {
    // Wird vom Status-Polling aufgerufen: offenes Modal mit frischen Spieldaten aktualisieren
    if (!modalState || !modalState.isOnline) return;
    const modal = document.getElementById('player-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (modalState.editing) return; // Nicht mitten in einer Bearbeitung neu rendern

    const player = (currentServerData.players || []).find(p => p.id == modalState.playerId);
    if (player) {
        renderPlayerModal(player);
    } else {
        setModalOfflineNotice();
    }
}

function setModalOfflineNotice() {
    modalState.isOnline = false;
    const body = document.getElementById('player-modal-body');
    if (!body) return;
    const dbId = guessDbIdentifier(modalState.identifier);
    body.innerHTML = `
        <div style="grid-column: 1 / -1; text-align:center; padding:40px; color:#aaa;">
            <i class="fas fa-user-slash" style="font-size:2rem; color:#444;"></i><br><br>
            Der Spieler hat den Server verlassen.
            ${dbId && canEditPlayers() ? `<br><br><button type="button" class="small-btn" onclick="showOfflineEditor('${safeAttr(dbId)}')"><i class="fas fa-database"></i> Offline-Daten laden & bearbeiten</button>` : ''}
        </div>`;
}

function safeAttr(value) {
    // Nur für Identifier in onclick-Attributen (alphanumerisch + : . - _)
    return String(value || '').replace(/[^\w:.\-]/g, '');
}

function guessDbIdentifier(identifier) {
    if (!identifier) return null;
    const norm = normalizeDbIdentifier(identifier);
    const cached = allPlayersCache.find(p => {
        const pid = String(p.identifier || '');
        return pid === identifier || pid === norm || pid.endsWith(norm);
    });
    return cached ? cached.identifier : norm;
}

function editPencil(field) {
    return ` <i class="fas fa-pen edit-pencil" onclick="startModalEdit('${field}')" title="Bearbeiten"></i>`;
}

function inlineEditActions(confirmCall) {
    return `
        <button type="button" class="mini-btn confirm" onclick="${confirmCall}" title="Speichern"><i class="fas fa-check"></i></button>
        <button type="button" class="mini-btn cancel" onclick="cancelModalEdit()" title="Abbrechen"><i class="fas fa-times"></i></button>`;
}

function moneyBoxHtml(type, icon, value, editable, editing) {
    const boxClass = type === 'cash' ? 'money-box' : 'bank-box';
    if (editing === type) {
        return `
        <div class="stat-box ${boxClass}">
            <i class="fas ${icon}"></i>
            <span class="inline-edit">
                <input type="number" id="edit-money-${type}" value="${Number(value) || 0}" min="0">
                ${inlineEditActions(`confirmEditMoney('${type}')`)}
            </span>
        </div>`;
    }
    return `
    <div class="stat-box ${boxClass}">
        <i class="fas ${icon}"></i> <span>${(Number(value) || 0).toLocaleString()} $</span>
        ${editable ? editPencil(type) : ''}
    </div>`;
}

function renderPlayerModal(player) {
    modalState.player = player;
    const editable = canEditPlayers(); // Online UND Offline bearbeitbar (offline via DB)
    const editing = modalState.editing;

    const idBadge = modalState.isOnline
        ? `ID ${player.id}`
        : `<span style="color:#ff4444; font-weight:700;">OFFLINE</span>`;
    document.getElementById('modal-player-name').innerHTML =
        `<span style="color:#666; font-size:0.9em; margin-right:10px;">${idBadge}</span> ${escapeHtml(player.name || 'Unbekannt')}`;

    // --- Linke Spalte: Info + Finanzen ---
    let infoHtml = '<h4>Info</h4>';
    infoHtml += `<div class="info-row"><span>Steam Name:</span> <span>${escapeHtml(player.name || '-')}</span></div>`;

    if (editing === 'ic_name') {
        infoHtml += `
        <div class="info-row"><span>IC Name:</span>
            <span class="inline-edit">
                <input type="text" id="edit-ic-name" value="${escapeHtml(player.rp_name || '')}" maxlength="50" placeholder="Vorname Nachname">
                ${inlineEditActions('confirmEditIcName()')}
            </span>
        </div>`;
    } else {
        infoHtml += `<div class="info-row"><span>IC Name:</span> <span>${escapeHtml(player.rp_name || 'Unbekannt')}${editable ? editPencil('ic_name') : ''}</span></div>`;
    }

    if (editing === 'job') {
        infoHtml += `
        <div class="info-row info-row-stacked"><span>Job:</span>
            <span class="inline-edit inline-edit-col">
                <select id="edit-job-name" class="select-input" onchange="populateGradeSelect(this.value)"></select>
                <select id="edit-job-grade" class="select-input"></select>
                <span class="inline-edit-actions">${inlineEditActions('confirmEditJob()')}</span>
            </span>
        </div>`;
    } else {
        infoHtml += `<div class="info-row"><span>Job:</span> <span>${escapeHtml(player.job || 'Unemployed')}${editable ? editPencil('job') : ''}</span></div>`;
    }

    if (modalState.isOnline) {
        infoHtml += `<div class="info-row"><span>Ping:</span> <span>${player.ping != null ? player.ping : '-'} ms</span></div>`;
    } else {
        infoHtml += `<div class="info-row"><span>Status:</span> <span style="color:#ff4444; font-weight:600;"><i class="fas fa-circle" style="font-size:0.6rem;"></i> Offline</span></div>`;
    }

    infoHtml += '<h4 style="margin-top:20px;">Finanzen</h4>';
    infoHtml += moneyBoxHtml('cash', 'fa-wallet', player.money?.cash, editable, editing);
    infoHtml += moneyBoxHtml('bank', 'fa-university', player.money?.bank, editable, editing);

    // --- Rechte Spalte: Inventar + Identifiers ---
    let invHtml = `
    <div class="inv-header">
        <h4>Inventar</h4>
        ${editable ? '<button type="button" class="mini-btn add" onclick="startModalEdit(\'add_item\')" title="Item geben"><i class="fas fa-plus"></i></button>' : ''}
    </div>`;

    if (editing === 'add_item') {
        invHtml += `
        <div class="add-item-form">
            <input type="text" id="add-item-name" placeholder="Spawnname (z.B. bread)">
            <input type="number" id="add-item-count" value="1" min="1">
            ${inlineEditActions('confirmAddItem()')}
        </div>`;
    }

    const inventory = player.inventory || [];
    if (inventory.length > 0) {
        invHtml += '<div class="inventory-grid">' + inventory.map(item => {
            const safeName = safeItemName(item.name);
            const label = escapeHtml(item.label || item.name);
            if (editing === 'item:' + safeName) {
                return `
                <div class="inv-item inv-item-editing">
                    ${label}
                    <span class="inline-edit">
                        <input type="number" id="edit-item-count" value="${Number(item.count) || 0}" min="0">
                        ${inlineEditActions(`confirmEditItem('${safeName}')`)}
                    </span>
                </div>`;
            }
            return `
            <div class="inv-item">
                ${label} <span class="inv-count">x${item.count}</span>
                ${editable ? `
                <span class="inv-actions">
                    <i class="fas fa-pen inv-action edit" onclick="startModalEdit('item:${safeName}')" title="Anzahl ändern"></i>
                    <i class="fas fa-times inv-action remove" onclick="removeInventoryItem('${safeName}')" title="Alle entfernen"></i>
                </span>` : ''}
            </div>`;
        }).join('') + '</div>';
    } else {
        invHtml += '<div style="color:#888; padding:6px 0;">Leer</div>';
    }

    invHtml += '<h4 style="margin-top:20px;">Identifiers</h4><div id="info-identifiers" class="code-box"></div>';

    document.getElementById('player-modal-body').innerHTML = `
        <div class="modal-col">${infoHtml}</div>
        <div class="modal-col">${invHtml}</div>`;

    renderIdentifiers(player.identifiers || []);

    // Edit-Modus: Dropdowns füllen, Fokus setzen, Enter-Taste binden
    if (editing === 'job') populateJobSelects(player);
    if (editing === 'ic_name') {
        bindEnter('edit-ic-name', confirmEditIcName);
        document.getElementById('edit-ic-name')?.focus();
    }
    if (editing === 'cash' || editing === 'bank') {
        bindEnter('edit-money-' + editing, () => confirmEditMoney(editing));
        document.getElementById('edit-money-' + editing)?.focus();
    }
    if (editing === 'add_item') {
        bindEnter('add-item-name', confirmAddItem);
        bindEnter('add-item-count', confirmAddItem);
        document.getElementById('add-item-name')?.focus();
    }
    if (editing && editing.startsWith('item:')) {
        const itemName = editing.slice(5);
        bindEnter('edit-item-count', () => confirmEditItem(itemName));
        document.getElementById('edit-item-count')?.focus();
    }
}

function bindEnter(elementId, fn) {
    const el = document.getElementById(elementId);
    if (el) el.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fn();
        }
    };
}

function renderIdentifiers(ids) {
    const idContainer = document.getElementById('info-identifiers');
    if (!idContainer) return;
    idContainer.innerHTML = '';

    const idMap = {
        'steam': { icon: 'fab fa-steam', label: 'Steam' },
        'discord': { icon: 'fab fa-discord', label: 'Discord' },
        'license': { icon: 'fas fa-id-card', label: 'License' },
        'license2': { icon: 'fas fa-id-card-alt', label: 'License 2' },
        'xbl': { icon: 'fab fa-xbox', label: 'Xbox' },
        'live': { icon: 'fab fa-microsoft', label: 'Live' },
        'ip': { icon: 'fas fa-network-wired', label: 'IP' }
    };

    ids.forEach(idStr => {
        const parts = String(idStr).split(':');
        const type = parts[0];
        const val = parts.slice(1).join(':');
        const meta = idMap[type] || { icon: 'fas fa-fingerprint', label: type };

        const row = document.createElement('div');
        row.className = 'identifier-card';
        row.style.cssText = 'background:rgba(255,255,255,0.05); padding:8px 10px; border-radius:5px; margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;';
        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <i class="${meta.icon}" style="width:20px; text-align:center; color:#aaa;"></i>
                <span style="color:#888; font-weight:600; font-size:0.85rem; min-width:60px;">${escapeHtml(meta.label)}</span>
            </div>
            <span style="font-family:monospace; color:#ddd; font-size:0.9rem; background:rgba(0,0,0,0.3); padding:2px 6px; border-radius:4px;">${escapeHtml(val)}</span>`;
        idContainer.appendChild(row);
    });
}

// --- Edit-State ---

function startModalEdit(field) {
    if (!modalState || !modalState.player) return;
    modalState.editing = field;
    renderPlayerModal(modalState.player);
}

function cancelModalEdit() {
    if (!modalState) return;
    modalState.editing = null;
    if (modalState.player) renderPlayerModal(modalState.player);
}

function finishModalEdit() {
    if (!modalState) return;
    modalState.editing = null;
    if (modalState.player) renderPlayerModal(modalState.player);
}

// --- Job Dropdowns ---

function populateJobSelects(player) {
    const jobSelect = document.getElementById('edit-job-name');
    const gradeSelect = document.getElementById('edit-job-grade');
    if (!jobSelect || !gradeSelect) return;

    if (serverJobs.length === 0) {
        jobSelect.innerHTML = '<option value="">Keine Jobs empfangen...</option>';
        gradeSelect.innerHTML = '<option value="">-</option>';
        fetchJobs(); // Erneut versuchen für das nächste Öffnen
        return;
    }

    // Aktuellen Job vorauswählen: bevorzugt exakter Job-Name (Offline-Details),
    // sonst über das Label (Online-Status liefert "Label - RangLabel")
    const jobParts = String(player.job || '').split(' - ');
    const currentJobLabel = jobParts[0];
    const currentGradeLabel = jobParts.slice(1).join(' - ');

    let selectedName;
    if (player.job_name && serverJobs.some(j => j.name === player.job_name)) {
        selectedName = player.job_name;
    } else {
        const current = serverJobs.find(j => j.label === currentJobLabel);
        selectedName = current ? current.name : serverJobs[0].name;
    }

    jobSelect.innerHTML = serverJobs.map(j =>
        `<option value="${escapeHtml(j.name)}" ${j.name === selectedName ? 'selected' : ''}>${escapeHtml(j.label)}</option>`
    ).join('');

    populateGradeSelect(selectedName, currentGradeLabel, player.job_grade);
}

function populateGradeSelect(jobName, currentGradeLabel = null, currentGrade = null) {
    const gradeSelect = document.getElementById('edit-job-grade');
    if (!gradeSelect) return;

    const job = serverJobs.find(j => j.name === jobName);
    const grades = (job && job.grades && job.grades.length > 0) ? job.grades : [{ grade: 0, label: 'Rang 0' }];

    gradeSelect.innerHTML = grades.map(g => {
        const selected = (currentGrade != null && Number(g.grade) === Number(currentGrade))
            || (currentGrade == null && currentGradeLabel && g.label === currentGradeLabel);
        return `<option value="${g.grade}" ${selected ? 'selected' : ''}>${escapeHtml(g.label)} (${g.grade})</option>`;
    }).join('');
}

// --- Aktionen an den Spielserver senden ---

async function sendPlayerAction(action, params) {
    if (!modalState) return false;
    try {
        const res = await fetchWithAuth('/api/fivem/player_action', {
            method: 'POST',
            body: JSON.stringify({
                action: action,
                id: modalState.playerId,
                identifier: modalState.identifier,
                params: params
            })
        });
        if (res) {
            showToast('An den Server gesendet - Werte aktualisieren sich gleich');
            if (!modalState.isOnline) {
                // Offline-Änderungen laufen über die DB -> Daten nach kurzer Zeit neu laden
                setTimeout(refreshOfflineDetails, 4500);
            }
            return true;
        }
        return false;
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
        return false;
    }
}

async function confirmEditIcName() {
    const input = document.getElementById('edit-ic-name');
    const name = input ? input.value.trim() : '';
    if (!name) {
        showToast('Name darf nicht leer sein', 'error');
        return;
    }
    await sendPlayerAction('set_name', { name: name });
    finishModalEdit();
}

async function confirmEditJob() {
    const job = document.getElementById('edit-job-name')?.value;
    const grade = document.getElementById('edit-job-grade')?.value;
    if (!job) {
        showToast('Bitte einen Job wählen', 'error');
        return;
    }
    if (grade === '' || grade == null) {
        showToast('Bitte einen Rang wählen', 'error');
        return;
    }
    await sendPlayerAction('set_job', { job: job, grade: parseInt(grade) });
    finishModalEdit();
}

async function confirmEditMoney(type) {
    const input = document.getElementById('edit-money-' + type);
    const amount = parseInt(input ? input.value : '');
    if (isNaN(amount) || amount < 0) {
        showToast('Ungültiger Betrag', 'error');
        return;
    }
    await sendPlayerAction(type === 'cash' ? 'set_cash' : 'set_bank', { amount: amount });
    finishModalEdit();
}

async function confirmEditItem(itemName) {
    const input = document.getElementById('edit-item-count');
    const count = parseInt(input ? input.value : '');
    if (isNaN(count) || count < 0) {
        showToast('Ungültige Anzahl', 'error');
        return;
    }
    await sendPlayerAction('set_item', { item: itemName, count: count });
    finishModalEdit();
}

async function confirmAddItem() {
    const name = (document.getElementById('add-item-name')?.value || '').trim();
    const count = parseInt(document.getElementById('add-item-count')?.value);
    if (!name) {
        showToast('Bitte Spawnname angeben', 'error');
        return;
    }
    if (isNaN(count) || count < 1) {
        showToast('Ungültige Anzahl', 'error');
        return;
    }
    await sendPlayerAction('add_item', { item: name, count: count });
    finishModalEdit();
}

async function removeInventoryItem(itemName) {
    const item = (modalState?.player?.inventory || []).find(i => safeItemName(i.name) === itemName);
    const label = item ? (item.label || item.name) : itemName;
    if (!confirm(`Wirklich alle "${label}" aus dem Inventar entfernen?`)) return;
    await sendPlayerAction('remove_item', { item: itemName });
}

function closePlayerModal() {
    document.getElementById('player-modal').classList.add('hidden');
    modalState = null;
}

// --- OFFLINE-EDITOR (Spieler aus der Datenbank bearbeiten) ---

function normalizeDbIdentifier(id) {
    return String(id || '').replace(/^char\d+:/, '').replace(/^license:/, '');
}

function findOnlinePlayerByDbIdentifier(dbIdentifier) {
    const norm = normalizeDbIdentifier(dbIdentifier);
    if (!norm) return null;
    return (currentServerData.players || []).find(p =>
        (p.identifiers || []).some(i => normalizeDbIdentifier(i) === norm)
    ) || null;
}

// Klick in "Alle Spieler": online -> Live-Editor, offline -> DB-Editor
function openPlayerByIdentifier(dbIdentifier) {
    const online = findOnlinePlayerByDbIdentifier(dbIdentifier);
    if (online) {
        showPlayerDetails(online.id);
    } else {
        showOfflineEditor(dbIdentifier);
    }
}

async function showOfflineEditor(dbIdentifier) {
    const cached = allPlayersCache.find(p => p.identifier === dbIdentifier);
    modalState = {
        playerId: null,
        identifier: dbIdentifier,
        isOnline: false,
        editing: null,
        player: null,
        detailSeq: Date.now() + Math.random()
    };
    const seq = modalState.detailSeq;

    document.getElementById('modal-player-name').innerHTML =
        `<span style="color:#ff4444; font-size:0.9em; margin-right:10px; font-weight:700;">OFFLINE</span> ${escapeHtml((cached && cached.name) || 'Spieler')}`;
    document.getElementById('player-modal-body').innerHTML = `
        <div style="grid-column: 1 / -1; text-align:center; padding:40px; color:#aaa;">
            <i class="fas fa-circle-notch fa-spin" style="font-size:1.6rem; color:#ff4e00;"></i><br><br>
            Lade Spielerdaten aus der Datenbank...<br>
            <small style="color:#666;">Der Game-Server beantwortet die Anfrage (wenige Sekunden)</small>
        </div>`;
    document.getElementById('player-modal').classList.remove('hidden');

    if (serverJobs.length === 0 && canEditPlayers()) fetchJobs();

    const details = await requestOfflineDetails(dbIdentifier);

    // Modal wurde inzwischen geschlossen oder ein anderer Spieler geöffnet?
    if (!modalState || modalState.detailSeq !== seq) return;

    if (!details) {
        renderOfflineFallback(cached, dbIdentifier, 'Game-Server nicht erreichbar - keine Detail-Daten verfügbar.');
        return;
    }
    if (details.found === false) {
        renderOfflineFallback(cached, dbIdentifier, 'Spieler wurde nicht in der Datenbank gefunden.');
        return;
    }

    modalState.player = buildOfflinePlayerObject(details, dbIdentifier);
    renderPlayerModal(modalState.player);
}

function buildOfflinePlayerObject(details, dbIdentifier) {
    return {
        id: null,
        name: details.name || 'Unbekannt',
        rp_name: details.rp_name || details.name || 'Unbekannt',
        job: details.job || 'Unbekannt',
        job_name: details.job_name,
        job_grade: details.job_grade,
        money: details.money || { cash: 0, bank: 0 },
        inventory: details.inventory || [],
        identifiers: [dbIdentifier],
        ping: null
    };
}

async function requestOfflineDetails(dbIdentifier) {
    try {
        const res = await fetchWithAuth('/api/fivem/player_details_request', {
            method: 'POST',
            body: JSON.stringify({ identifier: dbIdentifier })
        });
        if (!res) return null;
        const data = await res.json();
        const requestId = data.request_id;
        if (!requestId) return null;

        // Game-Server pollt alle 2s -> bis zu ~16s auf das Ergebnis warten
        for (let i = 0; i < 16; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const poll = await fetchWithAuth('/api/fivem/player_details?id=' + encodeURIComponent(requestId));
            if (!poll) return null;
            const result = await poll.json();
            if (result.status === 'ready') return result.data;
        }
    } catch (e) {
        console.warn('Offline-Details fehlgeschlagen', e);
    }
    return null;
}

async function refreshOfflineDetails() {
    if (!modalState || modalState.isOnline || !modalState.identifier) return;
    const modal = document.getElementById('player-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (modalState.editing) return;

    const seq = modalState.detailSeq;
    const identifier = modalState.identifier;
    const details = await requestOfflineDetails(identifier);
    if (!modalState || modalState.detailSeq !== seq || modalState.editing) return;
    if (details && details.found !== false) {
        modalState.player = buildOfflinePlayerObject(details, identifier);
        renderPlayerModal(modalState.player);
    }
}

function renderOfflineFallback(cached, dbIdentifier, note) {
    document.getElementById('player-modal-body').innerHTML = `
        <div class="modal-col">
            <h4>Info</h4>
            <div class="info-row"><span>Name:</span> <span>${escapeHtml((cached && cached.name) || 'Unbekannt')}</span></div>
            <div class="info-row"><span>IC Name:</span> <span>${escapeHtml((cached && cached.rp_name) || 'Unbekannt')}</span></div>
            <div class="info-row"><span>Job:</span> <span>${escapeHtml((cached && cached.job) || 'Unbekannt')}</span></div>
            <div class="info-row"><span>Letzter Login:</span> <span>${escapeHtml((cached && cached.last_seen) || 'N/A')}</span></div>
        </div>
        <div class="modal-col">
            <h4>Identifiers</h4>
            <div class="code-box">
                <div style="background:rgba(255,255,255,0.05); padding:8px 10px; border-radius:5px; color:#ccc; word-break:break-all;">${escapeHtml(dbIdentifier)}</div>
            </div>
            <div style="color:#ffaa00; margin-top:15px; font-size:0.85rem; line-height:1.5;">
                <i class="fas fa-exclamation-triangle"></i> ${escapeHtml(note)}
                <br><br>
                <button type="button" class="small-btn" onclick="showOfflineEditor('${safeAttr(dbIdentifier)}')">
                    <i class="fas fa-sync-alt"></i> Erneut versuchen
                </button>
            </div>
        </div>`;
}


// Close on outside click

window.onclick = function (event) {

    const modal = document.getElementById('player-modal');

    if (event.target == modal) {

        closePlayerModal();

    }

}



// --- LOGIN & ADMIN SYSTEM ---



function checkLogin() {

    const token = localStorage.getItem('adminToken');

    const overlay = document.getElementById('login-overlay');



    if (!token) {

        overlay.classList.remove('hidden');

        return false;

    }



    // Validate token exists (basic check), real validation happens on fetch

    userPermissions = JSON.parse(localStorage.getItem('adminPermissions') || '[]');

    applyPermissions();

    overlay.classList.add('hidden');

    return true;

}



async function handleLogin(e) {

    e.preventDefault();

    const user = document.getElementById('login-username').value;

    const pass = document.getElementById('login-password').value;

    const errorMsg = document.getElementById('login-error');



    try {

        const res = await fetch('/api/login', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ username: user, password: pass })

        });



        const data = await res.json();



        if (!res.ok) throw new Error(data.error || 'Login fehlgeschlagen');



        localStorage.setItem('adminToken', data.token);

        localStorage.setItem('adminUser', data.username);

        localStorage.setItem('adminPermissions', JSON.stringify(data.permissions));



        userPermissions = data.permissions;



        document.getElementById('login-overlay').classList.add('hidden');



        const savedUser = localStorage.getItem('adminUser') || 'Admin';

        const avatar = document.getElementById('user-avatar');

        if (avatar) avatar.textContent = savedUser.charAt(0).toUpperCase();



        // Reload init

        setupNavigation();

        setupDropdowns();

        setupColorPicker();

        setupPasswordToggle();

        setupBuilders();

        applyPermissions();

        await loadInitialData();

        await fetchAdmins();

        startPolling();



        // Apply user again for good measure

        if (avatar) avatar.textContent = savedUser.charAt(0).toUpperCase();



    } catch (err) {

        errorMsg.textContent = err.message;

        errorMsg.style.display = 'block';

    }

}



function logout() {

    localStorage.removeItem('adminToken');

    localStorage.removeItem('adminUser');

    localStorage.removeItem('adminPermissions');

    location.reload();

}



function toggleUserMenu() {

    document.getElementById('user-menu').classList.toggle('hidden');

}



// Close menu on outside click

window.addEventListener('click', function (e) {

    if (!document.querySelector('.user-profile').contains(e.target)) {

        document.getElementById('user-menu').classList.add('hidden');

    }

});



function applyPermissions() {

    const allElems = document.querySelectorAll('[data-permission]');

    const isSuper = userPermissions.includes('all');



    // 1. Items

    allElems.forEach(el => {

        const req = el.dataset.permission;

        if (isSuper || userPermissions.includes(req)) {

            el.style.display = ''; // Restore default display

            el.classList.remove('perm-hidden');

        } else {

            el.style.display = 'none';

            el.classList.add('perm-hidden');

        }

    });



    // 2. Hide empty Categories & Dropdowns

    document.querySelectorAll('.nav-category, .dropdown-menu').forEach(container => {

        // Check if container has permission attribute itself which is hidden

        if (container.classList.contains('perm-hidden')) return;



        // Check visible children

        // Use a small timeout or check logic directly.

        // Simple heuristic: If all `li` or `.nav-item` children are hidden, hide container.



        let hasVisible = false;



        // Check standard lists

        const items = container.querySelectorAll('.nav-item, li.nav-item');

        if (items.length > 0) {

            items.forEach(i => {

                if (i.style.display !== 'none') hasVisible = true;

            });

        }



        // Check dropdown contents specifically

        if (container.classList.contains('dropdown-menu')) {

            const subItems = container.querySelectorAll('.dropdown-content .nav-item');

            let subVisible = false;

            subItems.forEach(i => {

                if (i.style.display !== 'none') subVisible = true;

            });

            // Hide the header if no content

            if (!subVisible) container.style.display = 'none';

            else container.style.display = '';

        } else if (container.classList.contains('nav-category')) {

            // Find the NEXT UL sibling usually? Or controlled by finding children?

            // In HTML structure: Category is just a div. The UL follows it.

            // We need to find the UL associated with this category.

            // Hard to genericize without structure change.

            // Specific fix for "System": The UL is next sibling or nearby.



            // Simplest: Just check if the UL immediately following has visible items.

            const nextUl = container.nextElementSibling;

            if (nextUl && nextUl.tagName === 'UL') {

                const visibleItems = Array.from(nextUl.querySelectorAll('.nav-item')).filter(i => i.style.display !== 'none');

                if (visibleItems.length === 0) container.style.display = 'none';

                else container.style.display = '';

            }

        }

    });

}





let adminsCache = [];

async function fetchAdmins() {

    if (!userPermissions.includes('manage_admins') && !userPermissions.includes('all')) return;

    try {

        const res = await fetchWithAuth('/api/admins');

        if (!res) return;

        adminsCache = await res.json();

        const me = localStorage.getItem('adminUser');

        const container = document.getElementById('admin-list-container');

        container.innerHTML = adminsCache.map((a, i) => {

            const isMe = a.username === me;

            const initial = (a.username || '?').charAt(0).toUpperCase();

            const role = a.permissions.includes('all')
                ? 'Master Account'
                : `${a.permissions.length} Berechtigung${a.permissions.length === 1 ? '' : 'en'}`;

            return `
            <div class="admin-card">
                <div class="admin-card-head">
                    <div class="admin-avatar">${escapeHtml(initial)}</div>
                    <div class="admin-card-info">
                        <div class="admin-card-name">${escapeHtml(a.username)} ${isMe ? '<span class="badge admin-you">Du</span>' : ''}</div>
                        <div class="admin-card-role">${escapeHtml(role)}</div>
                    </div>
                    <div class="admin-card-actions">
                        ${isMe ? '<span class="admin-self-hint"><i class="fas fa-lock"></i> Eigener Account</span>' : `
                        <button class="btn-action edit" type="button" title="Bearbeiten" onclick="openAdminModalByIndex(${i}, event)"><i class="fas fa-edit"></i></button>
                        <button class="btn-action delete" type="button" title="Löschen" onclick="deleteAdminByIndex(${i}, event)"><i class="fas fa-trash"></i></button>`}
                    </div>
                </div>
                <div class="admin-card-perms">${renderPermChips(a.permissions)}</div>
            </div>`;

        }).join('');

    } catch (e) {

        console.error("Fetch Admins", e);

    }

}

function openAdminModalByIndex(i, event) {
    const a = adminsCache[i];
    if (a) openAdminModal(a.username, event);
}

function deleteAdminByIndex(i, event) {
    const a = adminsCache[i];
    if (a) deleteAdmin(a.username, event);
}



// --- ADMIN MODAL FUNCTIONS ---



// --- BERECHTIGUNGEN: Struktur automatisch aus der Sidebar ableiten ---
// Liest Kategorien -> Dropdowns -> Tabs direkt aus der Navigation, damit neue
// Menüpunkte automatisch als Berechtigung erscheinen (nichts hardcoded).

function buildPermissionStructure() {
    const structure = [];
    const nav = document.querySelector('.sidebar nav');
    if (!nav) return structure;

    const extract = (navItem) => {
        const read = navItem.dataset.permission;
        if (!read) return null;
        const span = navItem.querySelector('span');
        return {
            label: span ? span.textContent.trim() : read,
            read: read,
            write: navItem.dataset.permissionWrite || null
        };
    };

    let current = null;
    Array.from(nav.children).forEach(child => {
        if (child.classList.contains('nav-category')) {
            current = { name: child.textContent.trim(), groups: [], items: [] };
            structure.push(current);
        } else if (child.tagName === 'UL') {
            if (!current) {
                current = { name: 'Allgemein', groups: [], items: [] };
                structure.push(current);
            }
            const header = child.querySelector(':scope > .dropdown-header');
            if (header) {
                const hSpan = header.querySelector('span');
                const group = { name: hSpan ? hSpan.textContent.trim() : '', items: [] };
                child.querySelectorAll('.dropdown-content > .nav-item').forEach(ni => {
                    const p = extract(ni);
                    if (p) group.items.push(p);
                });
                if (group.items.length) current.groups.push(group);
            } else {
                child.querySelectorAll(':scope > .nav-item').forEach(ni => {
                    const p = extract(ni);
                    if (p) current.items.push(p);
                });
            }
        }
    });

    return structure.filter(cat => cat.items.length || cat.groups.length);
}

function permItemHtml(p) {
    if (p.write) {
        return `
        <div class="perm-row" data-read="${escapeHtml(p.read)}" data-write="${escapeHtml(p.write)}">
            <span class="perm-row-label">${escapeHtml(p.label)}</span>
            <select class="perm-level select-input">
                <option value="none">Kein Zugriff</option>
                <option value="read">Nur Lesen</option>
                <option value="rw">Lesen &amp; Schreiben</option>
            </select>
        </div>`;
    }
    return `
        <label class="perm-label perm-toggle-row" data-read="${escapeHtml(p.read)}">
            <span>${escapeHtml(p.label)}</span>
            <input type="checkbox" class="perm-toggle">
        </label>`;
}

function renderPermissionCheckboxes() {
    const container = document.getElementById('modal-permissions-container');
    if (!container) return;

    let html = '';
    buildPermissionStructure().forEach(cat => {
        html += `<div class="perm-cat"><div class="perm-cat-title">${escapeHtml(cat.name)}</div>`;
        if (cat.items.length) {
            html += '<div class="perm-grid">' + cat.items.map(permItemHtml).join('') + '</div>';
        }
        cat.groups.forEach(group => {
            html += `<div class="perm-dd"><div class="perm-dd-title"><i class="fas fa-folder-open"></i> ${escapeHtml(group.name)}</div>`;
            html += '<div class="perm-grid">' + group.items.map(permItemHtml).join('') + '</div></div>';
        });
        html += '</div>';
    });

    // Master-Account: Sonderrecht, das nicht aus der Navigation ableitbar ist
    html += `
        <div class="perm-master-box">
            <label class="perm-label perm-master">
                <span><i class="fas fa-crown" style="color:#ffce4e;"></i> Master Account (Vollzugriff auf alles)</span>
                <input type="checkbox" id="perm-master-toggle" onchange="onMasterToggle()">
            </label>
        </div>`;

    container.innerHTML = html;
}

function onMasterToggle() {
    const master = document.getElementById('perm-master-toggle');
    const isMaster = master && master.checked;
    document.querySelectorAll('#modal-permissions-container .perm-cat').forEach(cat => {
        cat.style.opacity = isMaster ? '0.4' : '1';
        cat.style.pointerEvents = isMaster ? 'none' : 'auto';
    });
}

function setModalPermissions(perms) {
    perms = perms || [];

    document.querySelectorAll('#modal-permissions-container .perm-row').forEach(row => {
        const sel = row.querySelector('.perm-level');
        if (perms.includes(row.dataset.write)) sel.value = 'rw';
        else if (perms.includes(row.dataset.read)) sel.value = 'read';
        else sel.value = 'none';
    });

    document.querySelectorAll('#modal-permissions-container .perm-toggle-row').forEach(row => {
        row.querySelector('.perm-toggle').checked = perms.includes(row.dataset.read);
    });

    const master = document.getElementById('perm-master-toggle');
    if (master) master.checked = perms.includes('all');
    onMasterToggle();
}

function harvestModalPermissions() {
    const master = document.getElementById('perm-master-toggle');
    if (master && master.checked) return ['all'];

    const perms = new Set();
    document.querySelectorAll('#modal-permissions-container .perm-row').forEach(row => {
        const level = row.querySelector('.perm-level').value;
        if (level === 'read') {
            perms.add(row.dataset.read);
        } else if (level === 'rw') {
            perms.add(row.dataset.read);   // Schreiben impliziert Lesen
            perms.add(row.dataset.write);
        }
    });
    document.querySelectorAll('#modal-permissions-container .perm-toggle-row').forEach(row => {
        if (row.querySelector('.perm-toggle').checked) perms.add(row.dataset.read);
    });
    return Array.from(perms);
}

// Berechtigungs-Chips für die Account-Übersicht (read = Auge, write = Stift)
function renderPermChips(perms) {
    const set = new Set(perms || []);
    if (set.has('all')) {
        return '<span class="perm-chip master"><i class="fas fa-crown"></i> Master – Vollzugriff</span>';
    }
    const chips = [];
    buildPermissionStructure().forEach(cat => {
        const items = [...cat.items];
        cat.groups.forEach(g => items.push(...g.items));
        items.forEach(p => {
            const hasRead = set.has(p.read);
            const hasWrite = p.write && set.has(p.write);
            if (hasWrite) {
                chips.push(`<span class="perm-chip rw"><i class="fas fa-pen"></i> ${escapeHtml(p.label)}</span>`);
            } else if (hasRead) {
                const icon = p.write ? '<i class="fas fa-eye"></i> ' : '';
                chips.push(`<span class="perm-chip">${icon}${escapeHtml(p.label)}</span>`);
            }
        });
    });
    if (!chips.length) return '<span class="perm-chip empty">Keine Berechtigungen</span>';
    return chips.join('');
}

async function openAdminModal(username = null, event = null) {

    if (event) event.preventDefault(); // Stop any form submit



    const modal = document.getElementById('admin-modal');

    renderPermissionCheckboxes(); // Build checkboxes dynamically

    modal.classList.remove('hidden');



    if (username) {

        document.getElementById('admin-modal-title').textContent = "Admin bearbeiten: " + username;

        document.getElementById('modal-admin-username').value = username;

        document.getElementById('modal-admin-username').disabled = true; // Cannot rename

        document.getElementById('modal-admin-password').value = ""; // Don't show password



        try {

            const res = await fetchWithAuth('/api/admins');

            if (res) {

                const admins = await res.json();

                const admin = admins.find(a => a.username === username);

                if (admin) {

                    setModalPermissions(admin.permissions);

                }

            }

        } catch (e) { }



    } else {

        document.getElementById('admin-modal-title').textContent = "Neuen Admin erstellen";

        document.getElementById('modal-admin-username').value = "";

        document.getElementById('modal-admin-username').disabled = false;

        document.getElementById('modal-admin-password').value = "";

        setModalPermissions([]);

    }

}







function closeAdminModal() {

    document.getElementById('admin-modal').classList.add('hidden');

}



async function saveAdminFromModal() {

    const user = document.getElementById('modal-admin-username').value;

    const pass = document.getElementById('modal-admin-password').value;



    // Harvest perms (aus den dynamisch erzeugten Read/Write-Controls)

    const perms = harvestModalPermissions();



    if (!user) {

        showToast('Bitte Username angeben', 'error');

        return;

    }



    // If new user, pass required. If edit, pass optional.

    const isEdit = document.getElementById('modal-admin-username').disabled;

    if (!isEdit && !pass) {

        showToast('Bitte Passwort angeben', 'error');

        return;

    }



    try {

        const res = await fetchWithAuth('/api/admins', {

            method: 'POST',

            body: JSON.stringify({ username: user, password: pass, permissions: perms })

        });



        if (res) {

            showToast('Account gespeichert!');

            closeAdminModal();

            fetchAdmins();

        }

    } catch (e) {

        showToast(e.message, 'error');

    }

}







async function deleteAdmin(username, event = null) {

    if (event) event.preventDefault();

    if (!confirm(`Account ${username} wirklich löschen?`)) return;



    try {

        await fetchWithAuth(`/api/admins/${encodeURIComponent(username)}`, { method: 'DELETE' });

        fetchAdmins();

        showToast('Account gelöscht');

    } catch (e) {

        showToast(e.message, 'error');

    }

}



async function fetchWithAuth(url, options = {}) {

    const token = localStorage.getItem('adminToken');

    if (!token) {

        checkLogin();

        return null; // Stop

    }



    const headers = options.headers || {};

    headers['Authorization'] = token;

    headers['Content-Type'] = 'application/json';



    const res = await fetch(url, { ...options, headers });

    if (res.status === 401) {

        localStorage.removeItem('adminToken');

        checkLogin();

        return null;

    }

    if (!res.ok) {

        const d = await res.json();

        throw new Error(d.error || 'Fehler');

    }

    return res;

}

// Player Tab Switching
function switchPlayerTab(tab) {
    const btnOnline = document.getElementById('btn-tab-online');
    const btnAll = document.getElementById('btn-tab-all');
    const tabOnline = document.getElementById('tab-online');
    const tabAll = document.getElementById('tab-all');

    if (tab === 'online') {
        btnOnline.classList.add('active');
        btnAll.classList.remove('active');
        tabOnline.classList.remove('hidden');
        tabAll.classList.add('hidden');
    } else {
        btnAll.classList.add('active');
        btnOnline.classList.remove('active');
        tabAll.classList.remove('hidden');
        tabOnline.classList.add('hidden');
        // Auto-load data if empty or stale
        const list = document.getElementById('all-player-list-body');
        if (!list.hasChildNodes() || list.innerHTML.includes('Klicke auf Laden')) {
            loadAllPlayers();
        }
    }
}

let allPlayersCache = [];

async function loadAllPlayers() {
    const list = document.getElementById('all-player-list-body');
    const searchInput = document.getElementById('all-player-search');

    // Bind search immediately
    if (searchInput) {
        searchInput.oninput = (e) => renderAllPlayers(e.target.value);
    }

    // Only fetch if cache is empty or a refresh is explicitly requested (not implemented yet, but good to keep in mind)
    if (allPlayersCache.length === 0) {
        list.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Lade Daten aus Datenbank...<br><small style="color:#666;">Dies kann einen Moment dauern</small></td></tr>';

        try {
            const res = await fetchWithAuth('/api/fivem/allplayers');
            if (!res) return;

            const players = await res.json();

            if (!Array.isArray(players) || players.length === 0) {
                list.innerHTML = `
                    <tr>
                        <td colspan="4" style="text-align:center; padding:30px; color:#aaa;">
                            <i class="fas fa-database" style="font-size:2rem; margin-bottom:10px; color:#444;"></i><br>
                            Keine Daten empfangen.<br>
                            <small>Warte auf Server-Sync oder Datenbank ist leer.</small><br><br>
                            <button class="small-btn" onclick="loadAllPlayers()">Erneut versuchen</button>
                        </td>
                    </tr>`;
                return;
            }

            allPlayersCache = players;

        } catch (e) {
            list.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:#ff4444;">Fehler: ${e.message}</td></tr>`;
            return; // Stop if fetch failed
        }
    }

    // Render with current search query
    renderAllPlayers(searchInput ? searchInput.value : "");
}

// --- RCON KONSOLE ---

function hasRconRead() {
    return userPermissions.includes('rcon_read') || userPermissions.includes('rcon_write') || userPermissions.includes('all');
}

function hasRconWrite() {
    return userPermissions.includes('rcon_write') || userPermissions.includes('all');
}

function setupConsoleInput() {
    const group = document.getElementById('console-input-group');
    const note = document.getElementById('console-readonly-note');
    const input = document.getElementById('console-input');
    const canWrite = hasRconWrite();

    // Eingabefeld nur bei Schreibrecht zeigen, sonst Lese-Hinweis
    if (group) group.style.display = canWrite ? '' : 'none';
    if (note) note.classList.toggle('hidden', canWrite);

    if (input && canWrite) {
        // Property-Zuweisung statt addEventListener -> idempotent bei Re-Login
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendConsoleCommand();
            }
        };
    }
}

async function sendConsoleCommand() {
    if (!hasRconWrite()) {
        showToast('Keine Schreibrechte für die Konsole', 'error');
        return;
    }
    const input = document.getElementById('console-input');
    if (!input || !input.value.trim()) return;

    const cmd = input.value.trim();
    const output = document.getElementById('console-output');

    // Clear input immediately
    input.value = '';

    try {
        const res = await fetchWithAuth('/api/fivem/command', {
            method: 'POST',
            body: JSON.stringify({ command: cmd })
        });

        if (res && res.ok) {
            // Success (Queued) - die Ausführung selbst erscheint über den Konsolen-Stream
            appendConsoleLine(`> ${cmd}`, '#0f0');
        }
    } catch (e) {
        appendConsoleLine(`[Fehler] ${e.message}`, '#ff4444');
    }

    output.scrollTop = output.scrollHeight;
}

let consolePollTimer = null;
let consoleLastId = 0;
let consoleConnected = false;

function startConsolePolling() {
    if (consolePollTimer) return;
    if (!hasRconRead()) return;
    consolePollTimer = setInterval(pollConsole, 2000);
    pollConsole();
}

function stripConsoleColors(text) {
    // FiveM Farbcodes (^0-^9) entfernen und Zeilenende säubern
    return String(text).replace(/\^[0-9]/g, '').replace(/\s+$/, '');
}

function appendConsoleLine(text, color = null) {
    const output = document.getElementById('console-output');
    if (!output) return;

    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 60;

    const div = document.createElement('div');
    div.textContent = text;
    if (color) div.style.color = color;
    output.appendChild(div);

    // DOM klein halten
    while (output.children.length > 1000) {
        output.removeChild(output.firstChild);
    }

    if (nearBottom) output.scrollTop = output.scrollHeight;
}

async function pollConsole() {
    const output = document.getElementById('console-output');
    if (!output) return;

    try {
        const res = await fetchWithAuth(`/api/fivem/console?after=${consoleLastId}`);
        if (!res) return;

        const data = await res.json();

        if (!consoleConnected) {
            consoleConnected = true;
            output.innerHTML = '';
            appendConsoleLine('Verbunden. Warte auf Server-Logs...', '#666');
        }

        if (Array.isArray(data.lines)) {
            data.lines.forEach(l => {
                const message = stripConsoleColors(l.message);
                if (!message) return;
                // Mehrzeilige Meldungen einzeln anhängen
                message.split('\n').forEach(part => {
                    if (part.trim() !== '') {
                        appendConsoleLine(part, l.channel === 'rcon' ? '#ffaa00' : null);
                    }
                });
            });
        }

        if (typeof data.last_id === 'number') {
            consoleLastId = data.last_id;
        }
    } catch (e) {
        // Verbindung verloren -> nächster Poll versucht es erneut
        console.warn('Console poll failed', e);
    }
}

function renderAllPlayers(query = "") {
    const list = document.getElementById('all-player-list-body');
    if (!list) return;

    let filtered = allPlayersCache;
    if (query) {
        const lowerQ = query.toLowerCase();
        filtered = allPlayersCache.filter(p =>
            (p.name && p.name.toLowerCase().includes(lowerQ)) ||
            (p.identifier && p.identifier.toLowerCase().includes(lowerQ)) ||
            (p.job && p.job.toLowerCase().includes(lowerQ))
        );
    }

    if (filtered.length === 0) {
        list.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#aaa;">Keine Spieler gefunden.</td></tr>';
        return;
    }

    const displayLimit = 100; // Limit to 100 to prevent browser lag
    const displayList = filtered.slice(0, displayLimit);

    list.innerHTML = displayList.map(p => `
        <tr onclick="openPlayerByIdentifier('${safeAttr(p.identifier)}')" style="cursor:pointer;">
            <td>
                <div class="player-name-cell">${escapeHtml(p.name || 'Unbekannt')}</div>
                <div class="player-id-sub">${escapeHtml(p.identifier)}</div>
            </td>
            <td><span style="color:${p.last_seen === 'Online' ? '#00ff88' : '#888'}">${escapeHtml(p.last_seen || 'N/A')}</span></td>
            <td>${escapeHtml(p.job)}</td>
            <td><!-- Action Empty --></td>
        </tr>
    `).join('');

    if (filtered.length > displayLimit) {
        list.innerHTML += `<tr><td colspan="4" style="text-align:center; padding:10px; color:#666; font-style:italic;">... und ${filtered.length - displayLimit} weitere. Bitte Suche verfeinern.</td></tr>`;
    }
}

// Hinweis: Die frühere showOfflinePlayer-Funktion wurde durch openPlayerByIdentifier
// (online -> Live-Editor, offline -> DB-Editor) ersetzt.

// --- LIVE KARTE (Leaflet) ---

// Kachel-Quelle: CreepPork/GTAV-Maps (MIT) - bei Bedarf auf lokalen Ordner umstellbar
const LIVEMAP_TILE_BASE = 'https://raw.githubusercontent.com/CreepPork/GTAV-Maps/master';
// Welt->Karte Kalibrierung (bewährte FiveM-LiveMap-Transformation, Karte = 11008px bei Zoom 7)
const LIVEMAP_CAL = {
    scaleX: 0.02072, offsetX: 117.3,
    scaleY: -0.0205, offsetY: 172.8,
    mapSize: 11008, maxNativeZoom: 7
};

let livemap = null;
let livemapLayersControl = null;
let livemapMarkers = {};   // playerId -> L.circleMarker
let livemapJobOptions = '';
let livemapFilters = { search: '', job: '' };

function livemapUnits() {
    return LIVEMAP_CAL.mapSize / Math.pow(2, LIVEMAP_CAL.maxNativeZoom);
}

function worldToLatLng(x, y) {
    // GTA-Weltkoordinate -> Anteil [0..1] der Kartenfläche -> CRS.Simple LatLng
    const fx = (LIVEMAP_CAL.scaleX * x + LIVEMAP_CAL.offsetX) / 256;
    const fy = (LIVEMAP_CAL.scaleY * y + LIVEMAP_CAL.offsetY) / 256;
    const units = livemapUnits();
    return L.latLng(-(fy * units), fx * units);
}

function initLivemap() {
    if (livemap) return;
    if (typeof L === 'undefined') {
        showToast('Karten-Bibliothek (Leaflet) konnte nicht geladen werden', 'error');
        return;
    }
    const el = document.getElementById('livemap');
    if (!el) return;

    const units = livemapUnits();
    const bounds = L.latLngBounds([[-units, 0], [0, units]]);

    livemap = L.map('livemap', {
        crs: L.CRS.Simple,
        minZoom: 2,
        maxZoom: 9,
        zoomControl: true,
        attributionControl: true,
        maxBounds: bounds.pad(0.3),
        maxBoundsViscosity: 0.6
    });

    const makeLayer = (style) => L.tileLayer(LIVEMAP_TILE_BASE + '/' + style + '/{z}-{x}_{y}.png', {
        minZoom: 0,
        maxZoom: 9,
        minNativeZoom: 0,
        maxNativeZoom: LIVEMAP_CAL.maxNativeZoom,
        noWrap: true,
        bounds: bounds,
        attribution: 'GTA V © Rockstar Games | Tiles: CreepPork/GTAV-Maps'
    });

    const atlas = makeLayer('atlas');
    const satellite = makeLayer('satellite');
    const road = makeLayer('road');
    satellite.addTo(livemap); // Standard-Stil: Satellit
    livemapLayersControl = L.control.layers(
        { 'Satellit': satellite, 'Atlas': atlas, 'Straßen': road },
        null,
        { position: 'topright' }
    ).addTo(livemap);

    livemap.fitBounds(bounds);
    // Standard-Ansicht: 2 Zoom-Stufen näher als die Gesamtübersicht (wie 2x auf "+" gedrückt)
    livemap.setView(bounds.getCenter(), livemap.getZoom() + 2, { animate: false });
    // ... und 5x nach unten (Pfeiltaste runter = 80px pro Druck)
    livemap.panBy([0, 5 * 80], { animate: false });

    // Filter-Listener
    const search = document.getElementById('map-filter-search');
    const job = document.getElementById('map-filter-job');
    if (search) search.oninput = applyLivemapFilters;
    if (job) job.onchange = applyLivemapFilters;
}

function jobBase(job) {
    return String(job || 'Unemployed').split(' - ')[0];
}

function applyLivemapFilters() {
    livemapFilters.search = (document.getElementById('map-filter-search')?.value || '').trim().toLowerCase();
    livemapFilters.job = document.getElementById('map-filter-job')?.value || '';
    updateLivemapMarkers(currentServerData);
}

function playerMatchesMapFilters(p) {
    const f = livemapFilters;
    if (f.search) {
        const hit = (p.name || '').toLowerCase().includes(f.search)
            || (p.rp_name || '').toLowerCase().includes(f.search)
            || String(p.id) === f.search;
        if (!hit) return false;
    }
    if (f.job && jobBase(p.job) !== f.job) return false;
    return true;
}

function livemapTooltipHtml(p) {
    const cash = (Number(p.money?.cash) || 0).toLocaleString();
    const bank = (Number(p.money?.bank) || 0).toLocaleString();
    return `
        <div class="lm-name">${escapeHtml(p.rp_name || p.name || 'Unbekannt')} <span class="lm-id">ID ${p.id}</span></div>
        <div class="lm-row"><i class="fas fa-briefcase"></i> ${escapeHtml(jobBase(p.job))}</div>
        <div class="lm-row"><i class="fas fa-wallet"></i> ${cash} $ &nbsp;&nbsp;<i class="fas fa-university"></i> ${bank} $</div>
        <div class="lm-hint"><i class="fas fa-mouse-pointer"></i> Klicken für Details & Bearbeiten</div>`;
}

function updateLivemapJobOptions(players) {
    const select = document.getElementById('map-filter-job');
    if (!select) return;
    const jobs = [...new Set(players.map(p => jobBase(p.job)))].sort((a, b) => a.localeCompare(b));
    const html = '<option value="">Alle Jobs</option>' + jobs.map(j =>
        `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`
    ).join('');
    if (html !== livemapJobOptions) {
        const current = select.value;
        select.innerHTML = html;
        livemapJobOptions = html;
        // Auswahl beibehalten, falls der Job noch existiert
        if ([...select.options].some(o => o.value === current)) select.value = current;
    }
}

function updateLivemapMarkers(data) {
    if (!livemap) return;
    const players = (data && data.online) ? (data.players || []) : [];
    const seen = {};
    let visible = 0;
    let withPos = 0;

    players.forEach(p => {
        if (!p.coords) return;
        withPos++;
        seen[p.id] = true;

        const pos = worldToLatLng(p.coords.x, p.coords.y);
        let marker = livemapMarkers[p.id];
        if (!marker) {
            marker = L.circleMarker(pos, {
                radius: 7,
                weight: 2,
                color: '#ffffff',
                fillColor: '#ff4e00',
                fillOpacity: 0.95
            });
            marker.bindTooltip('', {
                direction: 'top',
                offset: [0, -10],
                opacity: 1,
                className: 'livemap-tooltip'
            });
            marker.on('click', () => {
                if (marker.razePlayerId != null) showPlayerDetails(marker.razePlayerId);
            });
            livemapMarkers[p.id] = marker;
        }
        marker.razePlayerId = p.id;
        marker.setLatLng(pos);
        marker.setTooltipContent(livemapTooltipHtml(p));

        if (playerMatchesMapFilters(p)) {
            if (!livemap.hasLayer(marker)) marker.addTo(livemap);
            visible++;
        } else if (livemap.hasLayer(marker)) {
            marker.remove();
        }
    });

    // Marker von Spielern entfernen, die offline gegangen sind
    Object.keys(livemapMarkers).forEach(id => {
        if (!seen[id]) {
            livemapMarkers[id].remove();
            delete livemapMarkers[id];
        }
    });

    updateLivemapJobOptions(players);

    const counter = document.getElementById('map-player-count');
    if (counter) {
        const noPos = players.length - withPos;
        counter.innerHTML = `<i class="fas fa-users"></i> ${visible} / ${withPos}` +
            (noPos > 0 ? ` <small>(+${noPos} ohne Position)</small>` : '');
    }
}
