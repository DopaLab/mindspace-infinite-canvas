/**
 * MINDSPACE REMASTERED - V4.0
 */

const DB_NAME = 'MindspaceDB_V3';
const ZOOM_MIN = 0.1, ZOOM_MAX = 5.0;
const HISTORY_LIMIT = 60;
const VIEWPORT_MARGIN = 12;

// Default Fonts
const DEFAULT_FONTS = [
    "Inter", "JetBrains Mono", "Playfair Display", "Roboto", 
    "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "Comic Sans MS", "Segoe UI", "San Francisco"
];

// State
const state = {
    elements: [],
    strokes: [],
    knownFonts: [...DEFAULT_FONTS],
    view: { x: 0, y: 0, scale: 1 },
    tool: 'select',
    settings: { darkMode: false, brushSize: 4, brushColor: '#333333', orbPos: { x: 30, y: 30 } },
    selection: null,
    isDragging: false,
    isResizing: false,
    isPanning: false,
    isSpacePanning: false,
    isDrawing: false,
    pointerStart: { x: 0, y: 0 },
    dragOffset: { x: 0, y: 0 }
};

let localFontMap = new Map();// Stores the file references for local fonts
let history = [];
let historyIndex = -1;
let historyTimer = null;

const dom = {
    viewport: document.getElementById('viewport'),
    world: document.getElementById('world'),
    canvas: document.getElementById('drawing-canvas'),
    ctx: document.getElementById('drawing-canvas').getContext('2d'),
    orbWrapper: document.getElementById('orb-wrapper'),
    orbMain: document.getElementById('orb-main'),
    ctxMenu: document.getElementById('context-menu'),
    propBar: document.getElementById('property-bar'),
    fontInput: document.getElementById('prop-font-family'),
    fontList: document.getElementById('custom-font-list'),
    fileImport: document.getElementById('file-import'),
    saveIndicator: document.getElementById('save-indicator')
};

// --- REPLACE YOUR EXISTING init() FUNCTION WITH THIS ---
async function init() {
    try {
        await dbInit();
        await loadState();
        
        // NEW: Try to re-sync local fonts silently on startup
        if ('queryLocalFonts' in window) {
            const p = await navigator.permissions.query({ name: 'local-fonts' });
            if (p.state === 'granted') syncLocalFonts(true);
        }
        
    } catch (e) { console.error("DB Init failed", e); }
    
    // Global Event Listeners
    window.addEventListener('contextmenu', (e) => {
        if (e.target.matches('input, textarea') || e.target.isContentEditable) return;
        e.preventDefault(); handleContextMenu(e);
    });
    window.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('#prop-text-controls')) dom.fontList.classList.add('hidden');
        if (!e.target.closest('#context-menu')) dom.ctxMenu.classList.add('hidden');
        if (!e.target.closest('#orb-wrapper')) {
            dom.orbWrapper.classList.remove('open');
            dom.orbMain.setAttribute('aria-expanded', 'false');
        }
    });

    applySettings();
    renderElements();
    resizeCanvas();
    updateView();
    seedHistory();
    positionOrbMenu();

    const orbIcon = document.getElementById('orb-icon');
    orbIcon.addEventListener('error', () => {
        orbIcon.style.display = 'none';
        document.getElementById('orb-fallback').style.display = 'flex';
    }, { once: true });
    document.body.dataset.ready = 'true';
}

// --- DB & Persistence ---
let dbConn = null;
function dbInit() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = e => e.target.result.createObjectStore('store', { keyPath: 'key' });
        r.onsuccess = e => { dbConn = e.target.result; resolve(); };
        r.onerror = reject;
    });
}
async function saveState() {
    if(!dbConn) return;
    const dataToSave = { 
        key: 'mindspace_state', 
        data: { 
            elements: state.elements, 
            strokes: state.strokes, 
            view: state.view, 
            settings: state.settings, 
            fonts: state.knownFonts 
        } 
    };
    const transaction = dbConn.transaction('store', 'readwrite');
    transaction.objectStore('store').put(dataToSave);
    transaction.oncomplete = () => showToast('Saved');
    transaction.onerror = () => showToast('Could not save');
}

function showToast(message = 'Saved') {
    dom.saveIndicator.textContent = message;
    dom.saveIndicator.classList.add('visible');
    clearTimeout(window.saveIndTimer);
    window.saveIndTimer = setTimeout(() => dom.saveIndicator.classList.remove('visible'), 1000);
}

function stateSnapshot() {
    return JSON.stringify({ elements: state.elements, strokes: state.strokes, settings: state.settings });
}

function seedHistory() {
    history = [stateSnapshot()];
    historyIndex = 0;
    updateHistoryButtons();
}

function checkpoint({ debounced = false } = {}) {
    const push = () => {
        const snapshot = stateSnapshot();
        if (history[historyIndex] === snapshot) return;
        history = history.slice(0, historyIndex + 1);
        history.push(snapshot);
        if (history.length > HISTORY_LIMIT) history.shift();
        historyIndex = history.length - 1;
        updateHistoryButtons();
    };
    clearTimeout(historyTimer);
    if (debounced) historyTimer = setTimeout(push, 350);
    else push();
}

function restoreHistory(nextIndex) {
    if (nextIndex < 0 || nextIndex >= history.length || nextIndex === historyIndex) return;
    historyIndex = nextIndex;
    const snapshot = JSON.parse(history[historyIndex]);
    state.elements = snapshot.elements || [];
    state.strokes = snapshot.strokes || [];
    Object.assign(state.settings, snapshot.settings || {});
    state.selection = null;
    applySettings();
    renderElements();
    drawCanvas();
    saveState();
    updateHistoryButtons();
}

function undo() { restoreHistory(historyIndex - 1); }
function redo() { restoreHistory(historyIndex + 1); }

function updateHistoryButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
}

async function loadState() {
    if(!dbConn) return;
    return new Promise(resolve => {
        const r = dbConn.transaction('store', 'readonly').objectStore('store').get('mindspace_state');
        r.onsuccess = () => {
            if(r.result) {
                const s = r.result.data;
                state.elements = sanitizeElements(Array.isArray(s.elements) ? s.elements : []);
                state.strokes = sanitizeStrokes(Array.isArray(s.strokes) ? s.strokes : []);
                if (s.view && !isNaN(s.view.scale)) state.view = s.view;
                if(s.fonts && s.fonts.length > 0) state.knownFonts = [...new Set([...DEFAULT_FONTS, ...s.fonts])].sort();
                if(s.settings) Object.assign(state.settings, s.settings);
            }
            resolve();
        };
        r.onerror = resolve;
    });
}

// --- Import / Export ---
function exportBoard() {
    const backup = {
        meta: { name: 'Mindspace Backup', version: '4.0.0', date: new Date().toISOString() },
        state: { elements: state.elements, strokes: state.strokes, view: state.view, settings: state.settings, knownFonts: state.knownFonts }
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `mindspace_backup_${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
}

dom.fileImport.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { showToast('Backup is too large'); dom.fileImport.value = ''; return; }
    const reader = new FileReader();
    reader.onload = (evt) => {
        try {
            const json = JSON.parse(evt.target.result);
            if (json && json.state && Array.isArray(json.state.elements) && Array.isArray(json.state.strokes)) {
                if (confirm('Replace current board with backup?')) {
                    const s = json.state;
                    state.elements = sanitizeElements(s.elements);
                    state.strokes = sanitizeStrokes(s.strokes);
                    if (s.settings) Object.assign(state.settings, s.settings);
                    if (Array.isArray(s.knownFonts)) state.knownFonts = [...new Set([...DEFAULT_FONTS, ...s.knownFonts.filter(v => typeof v === 'string')])];
                    state.view = sanitizeView(s.view);
                    applySettings(); renderElements(); drawCanvas(); saveState();
                    seedHistory();
                    showToast('Backup loaded');
                }
            }
        } catch (err) { showToast('Invalid backup file'); }
        dom.fileImport.value = '';
    };
    reader.readAsText(file);
};
document.getElementById('btn-backup').onclick = exportBoard;
document.getElementById('btn-restore').onclick = () => dom.fileImport.click();

function applySettings() {
    if(state.settings.darkMode) document.body.setAttribute('data-theme', 'dark');
    else document.body.removeAttribute('data-theme');
    const x = clamp(Number(state.settings.orbPos?.x) || 30, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - 56 - VIEWPORT_MARGIN));
    const y = clamp(Number(state.settings.orbPos?.y) || 30, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - 56 - VIEWPORT_MARGIN));
    state.settings.orbPos = { x, y };
    dom.orbWrapper.style.left = x + 'px';
    dom.orbWrapper.style.bottom = y + 'px';
    document.getElementById('brush-size').value = state.settings.brushSize;
    document.getElementById('brush-color').value = state.settings.brushColor;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const createId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const isSafeImage = value => typeof value === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value);
const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function sanitizeView(view) {
    return {
        x: finite(view?.x, 0),
        y: finite(view?.y, 0),
        scale: clamp(finite(view?.scale, 1), ZOOM_MIN, ZOOM_MAX)
    };
}

function sanitizeStrokes(strokes) {
    return strokes.slice(0, 20000).filter(s => s && Array.isArray(s.points)).map(s => ({
        points: s.points.slice(0, 50000).map(p => ({ x: finite(p?.x, 0), y: finite(p?.y, 0) })),
        color: typeof s.color === 'string' ? s.color : '#333333',
        size: clamp(finite(s.size, 4), 1, 100),
        isEraser: Boolean(s.isEraser)
    }));
}

function sanitizeElements(elements) {
    const seen = new Set();
    return elements.slice(0, 10000).filter(item => item && ['text', 'image', 'link', 'widget-note'].includes(item.type)).map(item => {
        const copy = structuredClone(item);
        copy.id = typeof copy.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(copy.id) && !seen.has(copy.id) ? copy.id : createId();
        seen.add(copy.id);
        copy.x = finite(copy.x, 0); copy.y = finite(copy.y, 0);
        copy.width = clamp(finite(copy.width, copy.type === 'widget-note' ? 320 : 200), 40, 5000);
        if (copy.height != null) copy.height = clamp(finite(copy.height, 300), 40, 5000);
        if (copy.type === 'image' && !isSafeImage(copy.content)) copy.content = '';
        if (copy.type === 'link' && !/^https?:\/\//i.test(copy.content || '')) copy.content = 'https://example.com';
        if (copy.type === 'widget-note') {
            copy.title = typeof copy.title === 'string' ? copy.title.slice(0, 500) : 'New Note';
            copy.data = copy.data && typeof copy.data === 'object' ? copy.data : {};
            copy.data.text = typeof copy.data.text === 'string' ? copy.data.text : '';
            copy.data.image = isSafeImage(copy.data.image) ? copy.data.image : null;
            copy.data.todo = Array.isArray(copy.data.todo) ? copy.data.todo.slice(0, 1000).map(t => ({ text: String(t?.text || '').slice(0, 1000), checked: Boolean(t?.checked) })) : [];
            copy.data.strokes = sanitizeStrokes(Array.isArray(copy.data.strokes) ? copy.data.strokes : []);
            if (!['image', 'draw', 'text', 'todo'].includes(copy.activeTab)) copy.activeTab = 'text';
        }
        return copy;
    });
}

// --- Interactions ---
const toWorld = (sx, sy) => ({ x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale });
let activeStroke = null;
let resizingEl = null;

// Spacebar Pan
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !state.isSpacePanning && e.target.tagName !== 'INPUT' && !e.target.isContentEditable && e.target.tagName !== 'TEXTAREA') {
        state.isSpacePanning = true;
        dom.viewport.classList.add('panning');
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        state.isSpacePanning = false;
        if (!state.isPanning) dom.viewport.classList.remove('panning');
    }
});

dom.viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.note-widget') && !e.target.closest('.note-header')) {
        if (e.target.closest('.mini-canvas')) return; // Allow drawing on note
    }
    dom.ctxMenu.classList.add('hidden');

    if (e.button === 1 || (state.isSpacePanning && e.button === 0)) {
        e.preventDefault();
        state.isPanning = true;
        state.pointerStart = { x: e.clientX, y: e.clientY };
        dom.viewport.classList.add('panning');
        return;
    }

    if (e.button !== 0) return;

    state.pointerStart = { x: e.clientX, y: e.clientY };
    const wPos = toWorld(e.clientX, e.clientY);
    const elWrapper = e.target.closest('.board-element');

    if (state.tool === 'text') {
        if (!elWrapper) {
            const newId = addItem('text', '', wPos);
            setTool('select');
            state.selection = newId;
            renderElements();
            setTimeout(() => {
                const el = document.getElementById(newId).querySelector('.text-element');
                if(el) el.focus();
            }, 50);
        }
        return;
    }

    if (state.tool === 'select') {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true;
            resizingEl = state.elements.find(el => el.id === state.selection);
            e.stopPropagation();
            return;
        }
        if (elWrapper) {
            const id = elWrapper.id;
            const elData = state.elements.find(el => el.id === id);
            if (elData.type === 'text' && state.selection === id && e.target.classList.contains('text-element')) return; 
			if (elData.type === 'widget-note' && state.selection === id && e.target.classList.contains('note-title')) return;
            if (elData.type === 'widget-note' && state.selection === id && !e.target.closest('.note-header')) return;

            state.selection = id;
            state.isDragging = true;
            state.dragOffset = { x: wPos.x - elData.x, y: wPos.y - elData.y };
            renderElements();
            e.stopPropagation(); 
        } else {
            if (state.selection) { state.selection = null; renderElements(); }
        }
        return;
    }

    if (state.tool === 'draw' || state.tool === 'eraser') {
        state.isDrawing = true;
        activeStroke = {
            points: [{x: wPos.x, y: wPos.y}],
            color: state.settings.brushColor,
            size: state.settings.brushSize,
            isEraser: state.tool === 'eraser'
        };
        state.strokes.push(activeStroke);
        drawCanvas();
    }
});

window.addEventListener('pointermove', (e) => {
    const wPos = toWorld(e.clientX, e.clientY);

    if (state.isResizing && resizingEl) {
        const dx = (e.clientX - state.pointerStart.x) / state.view.scale;
        const dy = (e.clientY - state.pointerStart.y) / state.view.scale;
        let newW = Math.max(50, (resizingEl.width || 200) + dx);
        resizingEl.width = newW;
        if (resizingEl.height) resizingEl.height = Math.max(50, (resizingEl.height || 200) + dy);

        state.pointerStart = { x: e.clientX, y: e.clientY };
        const domEl = document.getElementById(resizingEl.id);
        if(domEl) {
            domEl.style.width = resizingEl.width + 'px';
            if(resizingEl.height) domEl.style.height = resizingEl.height + 'px';
        }
    } else if (state.isDragging && state.selection) {
        const el = state.elements.find(e => e.id === state.selection);
        if(el) {
            el.x = wPos.x - state.dragOffset.x;
            el.y = wPos.y - state.dragOffset.y;
            const domEl = document.getElementById(el.id);
            if(domEl) { domEl.style.left = el.x + 'px'; domEl.style.top = el.y + 'px'; }
            updatePropertyBar();
        }
    } else if (state.isPanning) {
        state.view.x += e.clientX - state.pointerStart.x;
        state.view.y += e.clientY - state.pointerStart.y;
        state.pointerStart = { x: e.clientX, y: e.clientY };
        updateView();
    } else if (state.isDrawing && activeStroke) {
        activeStroke.points.push({x: wPos.x, y: wPos.y});
        drawCanvas();
    }
});

window.addEventListener('pointerup', (e) => {
    if (state.isDragging && state.selection) {
        const el = state.elements.find(e => e.id === state.selection);
        if (el && Math.hypot(e.clientX - state.pointerStart.x, e.clientY - state.pointerStart.y) < 5 && el.type === 'link' && el.isExpanded) {
            window.open(el.content, '_blank', 'noopener,noreferrer');
        }
    }
    if (state.isDragging || state.isResizing || state.isPanning || state.isDrawing) {
        saveState();
        if (!state.isPanning) checkpoint();
    }
    if (state.isResizing && resizingEl && resizingEl.type === 'widget-note') renderElements(); // Re-render canvas

    state.isDragging = false; state.isResizing = false; state.isPanning = false; state.isDrawing = false;
    resizingEl = null; activeStroke = null;
    if(!state.isSpacePanning) dom.viewport.classList.remove('panning');
});

// --- Context Menu ---
function handleContextMenu(e) {
    const elWrapper = e.target.closest('.board-element');
    const menu = dom.ctxMenu;
    menu.innerHTML = '';
    
    if (elWrapper) {
        const elData = state.elements.find(el => el.id === elWrapper.id);
        state.selection = elWrapper.id;
        renderElements();

        if (elData.type === 'text') {
            addMenuItem(menu, 'Copy Text', async () => {
                try { await navigator.clipboard.writeText(elData.content); showToast('Text copied'); }
                catch { showToast('Copy failed'); }
            });
        } 
        // --- ADDED THIS BLOCK FOR IMAGES ---
        else if (elData.type === 'image') {
            addMenuItem(menu, 'Copy Image', async () => {
                try {
                    // Convert Data URL to Blob for the clipboard
                    const res = await fetch(elData.content);
                    const blob = await res.blob();
                    await navigator.clipboard.write([
                        new ClipboardItem({ [blob.type]: blob })
                    ]);
                    // Use showToast if you have it defined, otherwise alert
                    showToast('Image copied');
                } catch (err) {
                    console.error('Copy failed', err);
                    showToast('Copy failed');
                }
            });
        } 
        // -----------------------------------
        else if (elData.type === 'link') {
            addMenuItem(menu, elData.isExpanded ? 'Collapse' : 'Expand', () => { elData.isExpanded = !elData.isExpanded; renderElements(); saveState(); checkpoint(); });
            addDivider(menu);
            addMenuItem(menu, 'Open Link', () => window.open(elData.content, '_blank', 'noopener,noreferrer'));
        } else if (elData.type === 'widget-note') {
            addMenuItem(menu, 'Delete Note', () => deleteElement(elData.id), true);
        }
        
        if (elData.type !== 'widget-note') {
            addMenuItem(menu, 'Duplicate', () => duplicateElement(elData.id));
            addMenuItem(menu, 'Bring to Front', () => bringToFront(elData.id));
            addDivider(menu);
            addMenuItem(menu, 'Delete', () => deleteElement(elData.id), true);
        }
    } else {
        const pastePosition = toWorld(e.clientX, e.clientY);
        addMenuItem(menu, 'Paste from Clipboard', () => handlePasteFromMenu(pastePosition));
        addMenuItem(menu, 'Add Note', () => addNoteWidget(toWorld(e.clientX, e.clientY)));
        addMenuItem(menu, 'Clear Board', () => {
            if(confirm('Delete everything?')) { state.elements=[]; state.strokes=[]; renderElements(); resizeCanvas(); saveState(); checkpoint(); }
        }, true);
    }
    menu.classList.remove('hidden');
    requestAnimationFrame(() => placeFixedPanel(menu, e.clientX, e.clientY));
}

function placeFixedPanel(panel, anchorX, anchorY) {
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    let left = anchorX;
    let top = anchorY;
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) left = anchorX - width;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = anchorY - height;
    panel.style.left = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)) + 'px';
    panel.style.top = clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)) + 'px';
}

async function handlePasteFromMenu(pos) {
    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
            const imageType = item.types.find(type => type.startsWith('image/'));
            if (imageType) {
                const blob = await item.getType(imageType);
                const reader = new FileReader();
                reader.onload = event => addItem('image', event.target.result, pos);
                reader.readAsDataURL(blob);
                return;
            }
        }
        const text = await navigator.clipboard.readText();
        if (text) handlePasteData(text, pos);
        else showToast('Clipboard is empty');
    } catch (error) {
        console.warn('Clipboard paste failed', error);
        showToast('Clipboard access unavailable');
    }
}

function addMenuItem(menu, text, action, isDanger) {
    const div = document.createElement('div');
    div.className = `ctx-item ${isDanger ? 'danger' : ''}`;
    div.innerText = text;
    div.onclick = () => { action(); dom.ctxMenu.classList.add('hidden'); };
    menu.appendChild(div);
}
function addDivider(menu) {
    const d = document.createElement('div');
    d.style.cssText = 'height:1px; background:var(--text-primary); opacity:0.1; margin:4px 0;';
    menu.appendChild(d);
}

// --- Property Bar ---
function updatePropertyBar() {
    if (!state.selection) { dom.propBar.classList.add('hidden'); return; }
    const el = state.elements.find(e => e.id === state.selection);
    if(!el || el.type === 'widget-note') { dom.propBar.classList.add('hidden'); return; }

    dom.propBar.classList.remove('hidden');
    const txtCtrls = document.getElementById('prop-text-controls');
    txtCtrls.style.display = (el.type === 'text') ? 'flex' : 'none';
    document.getElementById('prop-color').value = el.color || '#1e293b';
    
    if (el.type === 'text') {
        dom.fontInput.value = el.fontFamily || 'Inter';
        document.getElementById('prop-font-size').value = el.fontSize || 18;
        document.getElementById('prop-bold').className = `icon-btn ${el.fontWeight === 'bold' ? 'active' : ''}`;
        document.getElementById('prop-italic').className = `icon-btn ${el.fontStyle === 'italic' ? 'active' : ''}`;
    }
}
document.getElementById('prop-font-size').oninput = (e) => updateSel({ fontSize: parseInt(e.target.value) });
document.getElementById('prop-color').oninput = (e) => updateSel({ color: e.target.value });
document.getElementById('prop-bold').onclick = () => { const el = state.elements.find(e => e.id === state.selection); if(el) updateSel({ fontWeight: el.fontWeight === 'bold' ? 'normal' : 'bold' }); };
document.getElementById('prop-italic').onclick = () => { const el = state.elements.find(e => e.id === state.selection); if(el) updateSel({ fontStyle: el.fontStyle === 'italic' ? 'normal' : 'italic' }); };
document.getElementById('prop-delete').onclick = () => deleteElement(state.selection);

function updateSel(props) {
    if(!state.selection) return;
    const el = state.elements.find(e => e.id === state.selection);
    if(el) { Object.assign(el, props); renderElements(); saveState(); updatePropertyBar(); checkpoint({ debounced: true }); }
}

function deleteElement(id) {
    state.elements = state.elements.filter(el => el.id !== id);
    state.selection = null; dom.propBar.classList.add('hidden'); renderElements(); saveState(); checkpoint();
}

function duplicateElement(id) {
    const source = state.elements.find(element => element.id === id);
    if (!source) return;
    const copy = structuredClone(source);
    copy.id = createId(); copy.x += 24; copy.y += 24;
    state.elements.push(copy); state.selection = copy.id;
    renderElements(); saveState(); checkpoint();
}

function bringToFront(id) {
    const index = state.elements.findIndex(element => element.id === id);
    if (index < 0 || index === state.elements.length - 1) return;
    state.elements.push(state.elements.splice(index, 1)[0]);
    renderElements(); saveState(); checkpoint();
}

// --- Render ---
function renderElements() {
    dom.world.innerHTML = '';
    state.elements.forEach(data => {
        const wrapper = document.createElement('div');
        wrapper.className = `board-element ${state.selection === data.id ? 'selected' : ''}`;
        wrapper.id = data.id;
        wrapper.style.left = data.x + 'px';
        wrapper.style.top = data.y + 'px';
        wrapper.style.width = data.width + 'px';
        if(data.height) wrapper.style.height = data.height + 'px';

        if (data.type === 'text') {
            const inner = document.createElement('div');
            inner.className = 'text-element'; inner.contentEditable = true; inner.innerText = data.content;
            inner.style.fontFamily = data.fontFamily || 'Inter'; inner.style.fontSize = (data.fontSize || 18) + 'px';
            inner.style.color = data.color || 'var(--text-primary)'; inner.style.fontWeight = data.fontWeight || 'normal'; inner.style.fontStyle = data.fontStyle || 'normal';
            inner.oninput = (e) => {
                data.content = e.target.innerText; wrapper.style.height = 'auto'; checkpoint({ debounced: true });
                clearTimeout(window.textSaveTimer); window.textSaveTimer = setTimeout(saveState, 350);
            };
            inner.onblur = () => { saveState(); checkpoint(); };
            wrapper.appendChild(inner);
        } else if (data.type === 'image') {
            const img = document.createElement('img'); img.className = 'image-element'; img.src = data.content; wrapper.appendChild(img);
        } else if (data.type === 'link') {
            const link = document.createElement('div'); link.className = `link-element ${data.isExpanded ? 'expanded' : 'collapsed'}`;
            if(data.color) link.style.color = data.color;
            try {
                const url = new URL(data.content);
                const favicon = document.createElement('img');
                favicon.src = chrome.runtime.getURL('/_favicon/') + `?pageUrl=${encodeURIComponent(url.href)}&size=64`;
                favicon.alt = '';
                link.appendChild(favicon);
                if (data.isExpanded) {
                    const label = document.createElement('span'); label.textContent = data.content; link.appendChild(label);
                } else wrapper.style.width = 'auto';
            } catch(e) { link.innerText = data.isExpanded ? data.content : '🔗'; }
            wrapper.appendChild(link);
        } else if (data.type === 'widget-note') {
            renderNoteWidget(data, wrapper);
        }

        if (state.selection === data.id) {
            const handle = document.createElement('div'); handle.className = 'resize-handle'; wrapper.appendChild(handle);
        }
        dom.world.appendChild(wrapper);

        // FIX: Init canvas AFTER appending to DOM so it has valid dimensions
        if (data.type === 'widget-note' && data.activeTab === 'draw') {
             initMiniCanvas(data, wrapper);
        }
    });
    updatePropertyBar();
}

// --- Note Widget Logic ---

function addNoteWidget(pos) {
    const id = createId();
    const newNote = {
        id, type: 'widget-note',
        x: pos.x, y: pos.y, width: 320, height: 380,
        title: 'New Note',
        lastEdited: new Date().toLocaleDateString(),
        activeTab: 'text',
        data: { text: '', todo: [], image: null, strokes: [] }
    };
    state.elements.push(newNote);
    state.selection = id;
    renderElements(); saveState(); checkpoint();
}

function renderNoteWidget(data, wrapper) {
    wrapper.style.display = 'flex';
    wrapper.innerHTML = `
        <div class="note-widget">
            <div class="note-header">
                <div class="note-info">
                    <input class="note-title" value="${escapeHTML(data.title)}" placeholder="Title">
                    <span class="note-date">${escapeHTML(data.lastEdited)}</span>
                </div>
                <div class="note-controls">
                    <button class="note-btn danger" title="Delete Note">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>
            <div class="note-tabs">
                <button class="tab-btn ${data.activeTab === 'image' ? 'active' : ''}" data-tab="image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
                <button class="tab-btn ${data.activeTab === 'draw' ? 'active' : ''}" data-tab="draw"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><circle cx="11" cy="11" r="2"/></svg></button>
                <button class="tab-btn ${data.activeTab === 'text' ? 'active' : ''}" data-tab="text"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
                <button class="tab-btn ${data.activeTab === 'todo' ? 'active' : ''}" data-tab="todo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></button>
            </div>
            <div class="note-content">
                <div class="phase-container ${data.activeTab === 'image' ? 'active' : ''}" id="p-image-${data.id}">
                    <div class="image-phase-wrapper">
                        ${isSafeImage(data.data.image) ? `<img src="${data.data.image}" class="note-img-preview" alt="Attached note image"> <button class="note-btn" id="rm-img-${data.id}">Remove</button>` : `<div class="img-placeholder" id="up-img-${data.id}"><span>Upload Image</span></div>`}
                    </div>
                </div>
                <div class="phase-container ${data.activeTab === 'draw' ? 'active' : ''}" id="p-draw-${data.id}" style="overflow:hidden; padding:0;">
                    <div class="note-canvas-wrapper">
                        <canvas class="mini-canvas" id="cvs-${data.id}"></canvas>
                        <div class="note-draw-tools">
                            <div class="color-dot" style="background:#000" data-c="#000000"></div>
                            <div class="color-dot" style="background:#ef4444" data-c="#ef4444"></div>
                            <div class="color-dot" style="background:#22c55e" data-c="#22c55e"></div>
                            <div class="color-dot" style="background:#3b82f6" data-c="#3b82f6"></div>
                        </div>
                    </div>
                </div>
                <div class="phase-container ${data.activeTab === 'text' ? 'active' : ''}" id="p-text-${data.id}">
                    <textarea class="note-textarea" placeholder="Write something...">${escapeHTML(data.data.text || '')}</textarea>
                </div>
                <div class="phase-container ${data.activeTab === 'todo' ? 'active' : ''}" id="p-todo-${data.id}">
                    <div class="todo-list" id="todo-list-${data.id}"></div>
                    <button class="add-todo-btn" id="add-todo-${data.id}">+ Add Item</button>
                </div>
            </div>
        </div>
    `;

    const widget = wrapper.querySelector('.note-widget');
    widget.addEventListener('pointerdown', (e) => { if(e.target.closest('.note-header')) return; e.stopPropagation(); });

    // Events
    const titleInp = widget.querySelector('.note-title');
    titleInp.oninput = (e) => { data.title = e.target.value; updateNoteMeta(data, widget); checkpoint({ debounced: true }); };
    titleInp.onblur = saveState;
    const delBtn = widget.querySelector('.note-btn.danger');
    // Critical: Stop propagation on pointerdown so the board doesn't re-render (which kills the click)
    delBtn.onpointerdown = (e) => e.stopPropagation();
    delBtn.onclick = () => {
        if (confirm('Delete this note?')) deleteElement(data.id); 
    };

    widget.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => { data.activeTab = btn.dataset.tab; renderElements(); saveState(); checkpoint(); };
    });

    const upImg = widget.querySelector(`#up-img-${data.id}`);
    if(upImg) {
        upImg.onclick = () => {
            const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
            input.onchange = e => { const f = e.target.files[0]; if(f) { const r = new FileReader(); r.onload = evt => { data.data.image = evt.target.result; renderElements(); saveState(); checkpoint(); }; r.readAsDataURL(f); } };
            input.click();
        };
        wrapper.onpaste = (e) => {
            if(data.activeTab !== 'image') return;
            const items = e.clipboardData.items;
            for(const item of items) { if(item.type.startsWith('image/')) { const b = item.getAsFile(); const r = new FileReader(); r.onload = evt => { data.data.image = evt.target.result; renderElements(); saveState(); checkpoint(); }; r.readAsDataURL(b); } }
        };
    }
    const rmImg = widget.querySelector(`#rm-img-${data.id}`);
    if(rmImg) rmImg.onclick = () => { data.data.image = null; renderElements(); saveState(); checkpoint(); };

    const txtArea = widget.querySelector('.note-textarea');
    if(txtArea) txtArea.oninput = (e) => { data.data.text = e.target.value; updateNoteMeta(data, widget); saveState(); checkpoint({ debounced: true }); };

    if(data.activeTab === 'todo') {
        const list = widget.querySelector(`#todo-list-${data.id}`);
        const renderTodos = () => {
            list.innerHTML = '';
            (data.data.todo || []).forEach((item, idx) => {
                const row = document.createElement('div'); row.className = `todo-item ${item.checked ? 'checked' : ''}`;
                row.innerHTML = `<input type="checkbox" class="todo-check" ${item.checked ? 'checked' : ''}><input type="text" class="todo-input" value="${escapeHTML(item.text)}"><button class="note-btn danger small">×</button>`;
                row.querySelector('.todo-check').onchange = (e) => { item.checked = e.target.checked; renderTodos(); saveState(); checkpoint(); };
                row.querySelector('.todo-input').oninput = (e) => { item.text = e.target.value; saveState(); checkpoint({ debounced: true }); };
                row.querySelector('.note-btn').onclick = () => { data.data.todo.splice(idx, 1); renderTodos(); saveState(); checkpoint(); };
                list.appendChild(row);
            });
        };
        renderTodos();
        widget.querySelector(`#add-todo-${data.id}`).onclick = () => { if(!data.data.todo) data.data.todo = []; data.data.todo.push({ text: '', checked: false }); renderTodos(); saveState(); checkpoint(); };
    }
}

function updateNoteMeta(data, widget) {
    data.lastEdited = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const dateEl = widget.querySelector('.note-date');
    if(dateEl) dateEl.innerText = data.lastEdited;
}

function initMiniCanvas(data, wrapper) {
    const canvas = wrapper.querySelector(`#cvs-${data.id}`);
    if(!canvas) return;
    
    // Safety check for dimensions
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // Wait for layout

    canvas.width = rect.width;
    canvas.height = rect.height;
    
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const redraw = () => {
        ctx.clearRect(0,0,canvas.width, canvas.height);
        if(data.data.strokes) {
            data.data.strokes.forEach(s => {
                ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = s.color;
                if(s.points.length > 0) { ctx.moveTo(s.points[0].x, s.points[0].y); for(let i=1; i<s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y); }
                ctx.stroke();
            });
        }
    };
    redraw();

    let isDrawing = false, currentStroke = null, color = '#000000';
    wrapper.querySelectorAll('.color-dot').forEach(dot => {
        dot.onclick = () => { wrapper.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active')); dot.classList.add('active'); color = dot.dataset.c; };
    });

    const getPos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.onpointerdown = (e) => { isDrawing = true; canvas.setPointerCapture(e.pointerId); currentStroke = { color, points: [getPos(e)] }; if(!data.data.strokes) data.data.strokes = []; data.data.strokes.push(currentStroke); redraw(); updateNoteMeta(data, wrapper); };
    canvas.onpointermove = (e) => { if(!isDrawing) return; currentStroke.points.push(getPos(e)); redraw(); };
    canvas.onpointerup = () => { isDrawing = false; saveState(); checkpoint(); };
}

function updateView() {
    dom.world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
    requestAnimationFrame(drawCanvas);
}

function drawCanvas() {
    const ctx = dom.ctx; ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
    ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of state.strokes) {
        ctx.globalCompositeOperation = s.isEraser ? 'destination-out' : 'source-over';
        ctx.beginPath(); ctx.lineWidth = s.size; ctx.strokeStyle = s.color;
        if (s.points.length === 1) {
            ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.fill();
        } else if(s.points.length > 1) {
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for(let i=1; i<s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
            ctx.stroke();
        }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
}

function resizeCanvas() { dom.canvas.width = window.innerWidth; dom.canvas.height = window.innerHeight; drawCanvas(); }
window.addEventListener('resize', () => { resizeCanvas(); applySettings(); positionOrbMenu(); });

dom.viewport.addEventListener('wheel', (e) => {
    if (e.target.closest('.phase-container') && e.target.closest('.phase-container').scrollHeight > e.target.closest('.phase-container').clientHeight) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || state.tool === 'draw' || state.tool === 'eraser') {
        const zoomIntensity = 0.001; const delta = -e.deltaY * zoomIntensity;
        const oldScale = state.view.scale; let newScale = oldScale * (1 + delta);
        newScale = Math.min(Math.max(newScale, ZOOM_MIN), ZOOM_MAX);
        const rect = dom.viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
        const wx = (mouseX - state.view.x) / oldScale; const wy = (mouseY - state.view.y) / oldScale;
        state.view.scale = newScale; state.view.x = mouseX - wx * newScale; state.view.y = mouseY - wy * newScale;
    } else { state.view.x -= e.deltaX; state.view.y -= e.deltaY; }
    updateView(); clearTimeout(window.saveTimer); window.saveTimer = setTimeout(saveState, 500);
}, { passive: false });

window.addEventListener('keydown', (e) => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && state.selection) { e.preventDefault(); duplicateElement(state.selection); return; }
    switch(e.key.toLowerCase()) {
        case 'v': setTool('select'); break; case 't': setTool('text'); break; case 'p': setTool('draw'); break; case 'e': setTool('eraser'); break;
        case 'delete': case 'backspace': if(state.selection) deleteElement(state.selection); break;
        case '0': fitAll(); break;
        case 'escape': state.selection = null; setTool('select'); renderElements(); dom.ctxMenu.classList.add('hidden'); break;
    }
});

dom.orbMain.onpointerdown = (e) => {
    e.stopPropagation(); if(e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = dom.orbWrapper.getBoundingClientRect();
    const startLeft = rect.left, startTop = rect.top;
    let moved = false;
    function move(ev) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) moved = true;
        const left = clamp(startLeft + ev.clientX - startX, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - 56 - VIEWPORT_MARGIN));
        const top = clamp(startTop + ev.clientY - startY, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - 56 - VIEWPORT_MARGIN));
        dom.orbWrapper.style.left = left + 'px';
        dom.orbWrapper.style.bottom = (window.innerHeight - top - 56) + 'px';
        positionOrbMenu();
    }
    function stop() {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop);
        state.settings.orbPos = { x: parseFloat(dom.orbWrapper.style.left), y: parseFloat(dom.orbWrapper.style.bottom) };
        if (!moved) {
            dom.orbWrapper.classList.toggle('open');
            dom.orbMain.setAttribute('aria-expanded', String(dom.orbWrapper.classList.contains('open')));
            positionOrbMenu();
        } else saveState();
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
};

function positionOrbMenu() {
    const menu = document.getElementById('orb-menu');
    const orbRect = dom.orbMain.getBoundingClientRect();
    const gap = 12;
    const roomAbove = orbRect.top - VIEWPORT_MARGIN - gap;
    const roomBelow = window.innerHeight - orbRect.bottom - VIEWPORT_MARGIN - gap;
    const naturalHeight = menu.scrollHeight;
    const openAbove = naturalHeight <= roomAbove || roomAbove >= roomBelow;
    const availableHeight = Math.max(40, openAbove ? roomAbove : roomBelow);

    menu.style.maxHeight = availableHeight + 'px';
    menu.style.top = openAbove ? 'auto' : `${56 + gap}px`;
    menu.style.bottom = openAbove ? `${56 + gap}px` : 'auto';

    const menuWidth = menu.offsetWidth;
    const alignRight = orbRect.left + menuWidth > window.innerWidth - VIEWPORT_MARGIN;
    menu.style.left = alignRight ? 'auto' : '0';
    menu.style.right = alignRight ? '0' : 'auto';
    menu.style.transformOrigin = `${openAbove ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}`;
    menu.dataset.placement = openAbove ? 'above' : 'below';
}

dom.orbWrapper.addEventListener('pointerenter', positionOrbMenu);
dom.orbWrapper.addEventListener('focusin', positionOrbMenu);
dom.orbMain.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        dom.orbWrapper.classList.toggle('open');
        dom.orbMain.setAttribute('aria-expanded', String(dom.orbWrapper.classList.contains('open')));
        positionOrbMenu();
    }
});

window.addEventListener('paste', (e) => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const center = toWorld(window.innerWidth/2, window.innerHeight/2);
    if (e.clipboardData.files.length) {
        const f = e.clipboardData.files[0];
        if (f.type.startsWith('image/')) { const r = new FileReader(); r.onload = evt => addItem('image', evt.target.result, center); r.readAsDataURL(f); }
    } else { const t = e.clipboardData.getData('text'); if(t) handlePasteData(t, center); }
});

function handlePasteData(text, pos) {
    if (/^(http|https):\/\//.test(text)) addItem('link', text, pos);
    else addItem('text', text, pos);
}

function addItem(type, content, pos) {
    const id = createId();
    const newItem = { id, type, x: pos.x, y: pos.y, width: type === 'text' ? 200 : (type === 'link' ? 50 : 300), height: type === 'image' ? 300 : null, content, isExpanded: false, fontSize: 18, fontFamily: 'Inter', color: type === 'text' ? document.getElementById('prop-color').value : null };
    state.elements.push(newItem); state.selection = id; renderElements(); saveState(); checkpoint(); return id;
}

function fitAll() {
    const bounds = [];
    state.elements.forEach(element => bounds.push({
        minX: element.x, minY: element.y,
        maxX: element.x + finite(element.width, 200),
        maxY: element.y + finite(element.height, element.type === 'text' ? 60 : 200)
    }));
    let strokeBounds = null;
    state.strokes.forEach(stroke => (stroke.points || []).forEach(point => {
        if (!strokeBounds) strokeBounds = { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
        else {
            strokeBounds.minX = Math.min(strokeBounds.minX, point.x); strokeBounds.minY = Math.min(strokeBounds.minY, point.y);
            strokeBounds.maxX = Math.max(strokeBounds.maxX, point.x); strokeBounds.maxY = Math.max(strokeBounds.maxY, point.y);
        }
    }));
    if (strokeBounds) bounds.push(strokeBounds);
    if (!bounds.length) state.view = { x: 0, y: 0, scale: 1 };
    else {
        const minX = Math.min(...bounds.map(bound => bound.minX));
        const minY = Math.min(...bounds.map(bound => bound.minY));
        const maxX = Math.max(...bounds.map(bound => bound.maxX));
        const maxY = Math.max(...bounds.map(bound => bound.maxY));
        const padding = 96;
        const width = Math.max(1, maxX - minX); const height = Math.max(1, maxY - minY);
        const scale = clamp(Math.min((window.innerWidth - padding * 2) / width, (window.innerHeight - padding * 2) / height), ZOOM_MIN, 2);
        state.view.scale = scale;
        state.view.x = (window.innerWidth - width * scale) / 2 - minX * scale;
        state.view.y = (window.innerHeight - height * scale) / 2 - minY * scale;
    }
    updateView(); saveState(); showToast(bounds.length ? 'Fit to content' : 'View reset');
}

document.getElementById('tool-select').onclick = () => setTool('select');
document.getElementById('tool-text').onclick = () => setTool('text');
document.getElementById('tool-draw').onclick = () => setTool('draw');
document.getElementById('tool-eraser').onclick = () => setTool('eraser');
document.getElementById('tool-note').onclick = () => { const center = toWorld(window.innerWidth/2 - 160, window.innerHeight/2 - 190); addNoteWidget(center); };
document.getElementById('btn-undo').onclick = undo;
document.getElementById('btn-redo').onclick = redo;
document.getElementById('btn-fit').onclick = fitAll;
document.getElementById('theme-toggle').onclick = () => { state.settings.darkMode = !state.settings.darkMode; applySettings(); drawCanvas(); saveState(); checkpoint(); };
document.getElementById('clear-board').onclick = () => { if(confirm('Clear all content?')) { state.elements=[]; state.strokes=[]; renderElements(); resizeCanvas(); saveState(); checkpoint(); } };
document.getElementById('brush-size').oninput = (e) => { state.settings.brushSize = parseInt(e.target.value); saveState(); };
document.getElementById('brush-color').oninput = (e) => { state.settings.brushColor = e.target.value; saveState(); };

function setTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    if (t !== 'note') document.getElementById(`tool-${t}`).classList.add('active');
    dom.viewport.className = '';
    if (t === 'draw' || t === 'eraser') dom.viewport.classList.add('drawing');
    if (t === 'text') dom.viewport.classList.add('text-mode');
    if(t !== 'select') { state.selection = null; renderElements(); }
}

init();

/* =========================================
   FONT MANAGEMENT SYSTEM
   ========================================= */

// 1. Syncs fonts from PC to Browser
async function syncLocalFonts(silent = false) {
    if (!('queryLocalFonts' in window)) {
        if(!silent) alert('Your browser does not support Local Font Access.');
        return;
    }

    try {
        let permissionState = 'prompt';
        try { permissionState = (await navigator.permissions.query({ name: 'local-fonts' })).state; }
        catch { /* queryLocalFonts will surface its own permission prompt. */ }
        if (permissionState === 'denied') {
            if(!silent) alert('Permission to access local fonts was denied.');
            return;
        }

        // Fetch fonts
        const fonts = await window.queryLocalFonts();
        
        // Store font data (blobs) mapped by family name
        localFontMap.clear();
        const fontNames = new Set(state.knownFonts); // Keep existing defaults

        for (const font of fonts) {
            fontNames.add(font.family);
            // We store the font object to load it manually later
            localFontMap.set(font.family, font);
        }

        // Update state and list
        state.knownFonts = [...fontNames].sort();
        if(!silent) {
            saveState();
            updateFontList('');
            showToast(`Synced ${fonts.length} fonts`);
        }
    } catch (e) {
        console.error('Font sync error:', e);
        if (!silent) showToast('Font sync unavailable');
    }
}

// 2. Loads the specific font file (Fixes Gibberish signs)
async function loadFontToCanvas(familyName) {
    if (!localFontMap.has(familyName)) return; // It's a standard web font

    try {
        const fontData = localFontMap.get(familyName);
        const blob = await fontData.blob(); // Get the actual file
        const fontFace = new FontFace(familyName, blob);
        await fontFace.load();
        document.fonts.add(fontFace); // Force browser to use this file
    } catch (e) {
        console.warn('Failed to load local font blob:', familyName, e);
    }
}

// 3. Updates the dropdown UI
function updateFontList(filter = '') {
    const list = dom.fontList;
    list.innerHTML = '';
    const term = filter.toLowerCase();
    
    // Add Sync Button at top
    const syncBtn = document.createElement('div');
    syncBtn.className = 'dropdown-item';
    syncBtn.style.background = 'var(--bg-color)';
    syncBtn.style.justifyContent = 'center';
    syncBtn.style.fontWeight = '600';
    syncBtn.innerHTML = '<span>↻ Sync Local Fonts</span>';
    syncBtn.onclick = () => syncLocalFonts(false);
    list.appendChild(syncBtn);

    // Filter available fonts
    const matches = state.knownFonts.filter(f => f.toLowerCase().includes(term));
    
    matches.forEach(font => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        
        // Layout: Name on left, Preview on right
        item.innerHTML = `
            <span class="font-name-label">${escapeHTML(font)}</span>
            <span class="font-preview-label" style="font-family: '${escapeHTML(font)}', sans-serif">Abc 123</span>
        `;
        
        item.onclick = async () => {
            dom.fontInput.value = font;
            
            // Fix: Load the font data before applying
            await loadFontToCanvas(font);
            
            updateSel({ fontFamily: font });
            list.classList.add('hidden');
        };
        list.appendChild(item);
    });
}

// 4. Input Behavior (Fixes the "Inter" delete issue)
dom.fontInput.onfocus = () => {
    dom.fontInput.select();   // Highlights text so you can overwrite immediately
    updateFontList('');       // Shows ALL fonts, not just matches
    dom.fontList.classList.remove('hidden');
};

dom.fontInput.oninput = (e) => {
    updateFontList(e.target.value); // Filters list as you type
    dom.fontList.classList.remove('hidden');
};

dom.fontInput.onkeydown = async (e) => {
    if (e.key === 'Enter') {
        const font = e.target.value;
        await loadFontToCanvas(font);
        updateSel({ fontFamily: font });
        dom.fontInput.blur();
        dom.fontList.classList.add('hidden');
    }
};
