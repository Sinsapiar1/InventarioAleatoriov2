document.addEventListener('DOMContentLoaded', () => {
    // Elementos del DOM
    const startScanButton = document.getElementById('startScanButton');
    const stopScanButton = document.getElementById('stopScanButton');
    const scannerContainer = document.getElementById('scannerContainer');
    const video = document.getElementById('scannerVideo');
    const canvasElement = document.getElementById('scannerCanvas');
    const canvasContext = canvasElement ? canvasElement.getContext('2d') : null;
    const manualPalletIdInput = document.getElementById('manualPalletIdInput');
    const checkManualButton = document.getElementById('checkManualButton');
    const resultDisplay = document.getElementById('resultDisplay');
    const palletSummary = document.getElementById('palletSummary');
    const loadingIndicator = document.getElementById('loadingIndicator');

    const sessionScannedListElement = document.getElementById('sessionScannedList');
    const finishSessionButton = document.getElementById('finishSessionButton');
    const sessionResultDisplay = document.getElementById('sessionResultDisplay');

    // Elementos para historial y edición
    const historyToggleButton = document.getElementById('historyToggleButton');
    const historySection = document.getElementById('historySection');
    const clearHistoryButton = document.getElementById('clearHistoryButton');
    const sessionRecoveryAlert = document.getElementById('sessionRecoveryAlert');

    // ---------- CONFIGURACIÓN - ¡REEMPLAZA ESTOS VALORES! ----------
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxLFasO1SNvthuC0U54Sqa6igGTk909bHiGX4-nuCOmdsyZ2lXi5Cu5E7AZSc81GtpjMg/exec'; 
    const API_KEY_FOR_SCRIPT = 'TuClaveSecretaInventadaSuperLarga123!@#'; 
    const SPREADSHEET_ID_FOR_LOG_LINK = "19DyoMu1V7xI5MrnbUvRTCjcKIboQKXS3QjdZt3zc-F4"; 
    const LOG_SHEET_GID_FOR_LOG_LINK = "1250649243"; 
    // ---------------------------------------------------------------

    // Claves para localStorage
    const STORAGE_KEYS = {
        SESSION_DATA: 'inventario_session_data',
        HISTORY: 'inventario_history',
        LAST_SESSION: 'inventario_last_session_timestamp'
    };

    // Estado de la aplicación
    let scanning = false;
    let stream = null;
    let scannedPalletsSessionData = []; 
    let lastScannedIdForTick = null; 
    let scanDebounceTimeout = null;
    let quaggaScanner = null;
    let isProcessingRequest = false;

    // Sistema de logging mejorado
    const Logger = {
        log: (message, data = '') => {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] [INFO] ${message}`, data);
        },
        error: (message, error = '') => {
            const timestamp = new Date().toISOString();
            console.error(`[${timestamp}] [ERROR] ${message}`, error);
        },
        warn: (message, data = '') => {
            const timestamp = new Date().toISOString();
            console.warn(`[${timestamp}] [WARN] ${message}`, data);
        },
        debug: (message, data = '') => {
            const timestamp = new Date().toISOString();
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.debug(`[${timestamp}] [DEBUG] ${message}`, data);
            }
        }
    };

    // Inicializar utilidades globales
    function initializeUtilities() {
        if (!window.InventorySystem) window.InventorySystem = {};
        if (!window.InventorySystem.Utils) window.InventorySystem.Utils = {};
        
        if (!window.InventorySystem.Utils.formatNumber) {
            window.InventorySystem.Utils.formatNumber = function(num) {
                const parsedNum = parseFloat(num);
                if (isNaN(parsedNum) || num === null || num === undefined || num === '') return 'N/A';
                return Number(parsedNum).toLocaleString('es-ES', { 
                    minimumFractionDigits: 0, 
                    maximumFractionDigits: 2 
                });
            };
        }

        if (!window.InventorySystem.Utils.sanitizeId) {
            window.InventorySystem.Utils.sanitizeId = function(text) {
                if (!text) return `item-${Date.now()}`;
                return String(text).trim().replace(/[^a-zA-Z0-9-_]/g, '-');
            };
        }

        if (!window.InventorySystem.Utils.validatePalletId) {
            window.InventorySystem.Utils.validatePalletId = function(id) {
                const trimmed = String(id || '').trim();
                return {
                    isValid: trimmed.length > 0 && trimmed.length <= 50,
                    value: trimmed,
                    error: trimmed.length === 0 ? 'ID requerido' : 
                           trimmed.length > 50 ? 'ID muy largo' : null
                };
            };
        }
    }

    // Sistema de persistencia mejorado
    const PersistenceManager = {
        // Verificar disponibilidad de localStorage
        isAvailable: function() {
            try {
                const test = 'localStorage-test';
                localStorage.setItem(test, test);
                localStorage.removeItem(test);
                return true;
            } catch (error) {
                Logger.error('localStorage no disponible', error);
                return false;
            }
        },

        // Guardar datos de sesión con validación
        saveSessionData: function(data) {
            if (!this.isAvailable()) return false;
            
            try {
                if (!Array.isArray(data)) {
                    throw new Error('Los datos deben ser un array');
                }

                const sessionData = {
                    pallets: data,
                    timestamp: Date.now(),
                    sessionId: this.generateSessionId(),
                    version: '2.1.0'
                };
                
                localStorage.setItem(STORAGE_KEYS.SESSION_DATA, JSON.stringify(sessionData));
                localStorage.setItem(STORAGE_KEYS.LAST_SESSION, sessionData.timestamp.toString());
                
                Logger.log('Datos de sesión guardados', { 
                    pallets: data.length, 
                    sessionId: sessionData.sessionId 
                });
                return true;
            } catch (error) {
                Logger.error('Error al guardar datos de sesión', error);
                return false;
            }
        },

        // Cargar datos de sesión con validación
        loadSessionData: function() {
            if (!this.isAvailable()) return null;
            
            try {
                const sessionData = localStorage.getItem(STORAGE_KEYS.SESSION_DATA);
                if (!sessionData) return null;

                const parsed = JSON.parse(sessionData);
                
                // Validar estructura
                if (!parsed.pallets || !Array.isArray(parsed.pallets)) {
                    Logger.warn('Datos de sesión inválidos, limpiando...');
                    this.clearSessionData();
                    return null;
                }

                Logger.log('Datos de sesión cargados', { 
                    pallets: parsed.pallets.length,
                    sessionId: parsed.sessionId 
                });
                return parsed;
            } catch (error) {
                Logger.error('Error al cargar datos de sesión', error);
                this.clearSessionData(); // Limpiar datos corruptos
                return null;
            }
        },

        // Limpiar datos de sesión actual
        clearSessionData: function() {
            if (!this.isAvailable()) return;
            
            try {
                localStorage.removeItem(STORAGE_KEYS.SESSION_DATA);
                localStorage.removeItem(STORAGE_KEYS.LAST_SESSION);
                Logger.log('Datos de sesión limpiados');
            } catch (error) {
                Logger.error('Error al limpiar datos de sesión', error);
            }
        },

        // Guardar en historial con validación
        saveToHistory: function(sessionData) {
            if (!this.isAvailable()) return false;
            
            try {
                let history = this.getHistory();
                
                const historyEntry = {
                    sessionId: sessionData.sessionId || this.generateSessionId(),
                    timestamp: sessionData.timestamp || Date.now(),
                    pallets: sessionData.pallets || sessionData,
                    processed: true,
                    summary: this.generateSessionSummary(sessionData.pallets || sessionData),
                    version: '2.1.0'
                };

                // Verificar si ya existe la sesión
                const existingIndex = history.findIndex(h => h.sessionId === historyEntry.sessionId);
                if (existingIndex !== -1) {
                    Logger.warn('Sesión ya existe en historial, actualizando...', { sessionId: historyEntry.sessionId });
                    history[existingIndex] = historyEntry;
                } else {
                    history.unshift(historyEntry); // Agregar al inicio
                }
                
                // Mantener solo los últimos 50 registros
                if (history.length > 50) {
                    history = history.slice(0, 50);
                }

                localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
                Logger.log('Guardado en historial', { sessionId: historyEntry.sessionId });
                return true;
            } catch (error) {
                Logger.error('Error al guardar en historial', error);
                return false;
            }
        },

        // Obtener historial con validación
        getHistory: function() {
            if (!this.isAvailable()) return [];
            
            try {
                const history = localStorage.getItem(STORAGE_KEYS.HISTORY);
                if (!history) return [];
                
                const parsed = JSON.parse(history);
                if (!Array.isArray(parsed)) {
                    Logger.warn('Historial inválido, reiniciando...');
                    this.clearHistory();
                    return [];
                }
                
                return parsed;
            } catch (error) {
                Logger.error('Error al obtener historial', error);
                this.clearHistory(); // Limpiar datos corruptos
                return [];
            }
        },

        // Limpiar historial
        clearHistory: function() {
            if (!this.isAvailable()) return;
            
            try {
                localStorage.removeItem(STORAGE_KEYS.HISTORY);
                Logger.log('Historial limpiado');
            } catch (error) {
                Logger.error('Error al limpiar historial', error);
            }
        },

        // Generar ID de sesión único
        generateSessionId: function() {
            return 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        },

        // Generar resumen de sesión mejorado
        generateSessionSummary: function(pallets) {
            if (!Array.isArray(pallets)) return { total: 0, found: 0, notFound: 0, withCounts: 0, completedItems: 0 };
            
            const total = pallets.length;
            const found = pallets.filter(p => p.found).length;
            const notFound = total - found;
            const withCounts = pallets.filter(p => 
                p.products && p.products.some(prod => prod.cantidadContada !== undefined)
            ).length;

            const completedItems = pallets.reduce((acc, p) => {
                if (p.products && Array.isArray(p.products)) {
                    return acc + p.products.filter(prod => prod.cantidadContada !== undefined).length;
                }
                return acc;
            }, 0);

            return { total, found, notFound, withCounts, completedItems };
        },

        // Verificar si hay una sesión reciente sin procesar
        hasRecentSession: function() {
            const sessionData = this.loadSessionData();
            if (!sessionData) return false;

            // Considerar reciente si es menor a 24 horas
            const hoursSinceLastSession = (Date.now() - sessionData.timestamp) / (1000 * 60 * 60);
            return hoursSinceLastSession < 24 && sessionData.pallets.length > 0;
        }
    };

    // Manejador de historial mejorado
    const HistoryManager = {
        isVisible: false,

        // Mostrar/ocultar sección de historial
        toggleHistorySection: function() {
            this.isVisible = !this.isVisible;
            
            if (this.isVisible) {
                this.renderHistory();
                historySection.classList.remove('hidden');
                historyToggleButton.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                    Ocultar Historial
                `;
            } else {
                historySection.classList.add('hidden');
                historyToggleButton.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12,6 12,12 16,14"/>
                    </svg>
                    Ver Historial
                `;
            }
        },

        // Renderizar historial con mejor manejo de errores
        renderHistory: function() {
            const historyList = document.getElementById('historyList');
            if (!historyList) {
                Logger.error('Elemento historyList no encontrado');
                return;
            }

            const history = PersistenceManager.getHistory();

            if (history.length === 0) {
                historyList.innerHTML = '<li class="history-empty">No hay historial de sesiones</li>';
                return;
            }

            try {
                historyList.innerHTML = history.map((entry, index) => {
                    const date = new Date(entry.timestamp);
                    const dateStr = date.toLocaleDateString('es-ES', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });

                    const summary = entry.summary || { total: 0, found: 0, notFound: 0, withCounts: 0 };

                    return `
                        <li class="history-entry" data-session-id="${entry.sessionId}">
                            <div class="history-entry-header">
                                <div class="history-entry-info">
                                    <strong>Sesión ${index + 1}</strong>
                                    <span class="history-date">${dateStr}</span>
                                </div>
                                <div class="history-entry-actions">
                                    <button class="btn-icon view-session-btn" title="Ver detalles" data-session-id="${entry.sessionId}">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="btn-icon restore-session-btn" title="Restaurar sesión" data-session-id="${entry.sessionId}">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2 2 2 0 012-2h10l2 2v2"/>
                                        </svg>
                                    </button>
                                    <button class="btn-icon delete-session-btn" title="Eliminar sesión" data-session-id="${entry.sessionId}">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="3,6 5,6 21,6"/>
                                            <path d="M19,6V20a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            <div class="history-entry-summary">
                                <span class="summary-item">Total: ${summary.total}</span>
                                <span class="summary-item found">Encontrados: ${summary.found}</span>
                                <span class="summary-item not-found">No encontrados: ${summary.notFound}</span>
                                <span class="summary-item counted">Con conteo: ${summary.withCounts}</span>
                            </div>
                        </li>
                    `;
                }).join('');

                // Agregar event listeners
                this.attachHistoryEventListeners();
                
            } catch (error) {
                Logger.error('Error al renderizar historial', error);
                historyList.innerHTML = '<li class="history-error">Error al cargar el historial</li>';
            }
        },

        // Agregar event listeners para botones del historial con manejo de errores
        attachHistoryEventListeners: function() {
            try {
                // Ver detalles de sesión
                document.querySelectorAll('.view-session-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const sessionId = e.target.closest('.view-session-btn').dataset.sessionId;
                        this.viewSessionDetails(sessionId);
                    });
                });

                // Restaurar sesión
                document.querySelectorAll('.restore-session-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const sessionId = e.target.closest('.restore-session-btn').dataset.sessionId;
                        this.confirmRestoreSession(sessionId);
                    });
                });

                // Eliminar sesión
                document.querySelectorAll('.delete-session-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const sessionId = e.target.closest('.delete-session-btn').dataset.sessionId;
                        this.confirmDeleteSession(sessionId);
                    });
                });
            } catch (error) {
                Logger.error('Error al adjuntar event listeners del historial', error);
            }
        },

        // Ver detalles de una sesión
        viewSessionDetails: function(sessionId) {
            const history = PersistenceManager.getHistory();
            const session = history.find(s => s.sessionId === sessionId);
            
            if (!session) {
                displayResult('Sesión no encontrada', true);
                return;
            }

            SessionDetailModal.show(session);
        },

        // Confirmar restaurar sesión
        confirmRestoreSession: function(sessionId) {
            PalletManager.showConfirmation(
                'Restaurar Sesión',
                '¿Desea restaurar esta sesión? Se reemplazará la sesión actual.',
                () => this.restoreSession(sessionId)
            );
        },

        // Restaurar sesión
        restoreSession: function(sessionId) {
            const history = PersistenceManager.getHistory();
            const session = history.find(s => s.sessionId === sessionId);
            
            if (!session) {
                displayResult('Sesión no encontrada', true);
                return;
            }

            try {
                // Restaurar datos
                scannedPalletsSessionData = [...session.pallets];
                
                // Guardar en sesión actual
                PersistenceManager.saveSessionData(scannedPalletsSessionData);
                
                // Actualizar UI
                updateSessionScannedList();
                displayResult(`Sesión restaurada correctamente (${session.pallets.length} pallets)`, false);
                
                // Ocultar historial
                this.toggleHistorySection();
                
                Logger.log('Sesión restaurada', { sessionId, pallets: session.pallets.length });
            } catch (error) {
                Logger.error('Error al restaurar sesión', error);
                displayResult('Error al restaurar la sesión', true);
            }
        },

        // Confirmar eliminar sesión
        confirmDeleteSession: function(sessionId) {
            PalletManager.showConfirmation(
                'Eliminar Sesión',
                '¿Está seguro de eliminar esta sesión del historial? Esta acción no se puede deshacer.',
                () => this.deleteSession(sessionId)
            );
        },

        // Eliminar sesión del historial
        deleteSession: function(sessionId) {
            try {
                let history = PersistenceManager.getHistory();
                const originalLength = history.length;
                
                history = history.filter(s => s.sessionId !== sessionId);
                
                if (history.length === originalLength) {
                    displayResult('Sesión no encontrada en el historial', true);
                    return;
                }

                localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
                
                // Actualizar vista
                this.renderHistory();
                displayResult('Sesión eliminada del historial', false);
                
                Logger.log('Sesión eliminada del historial', { sessionId });
            } catch (error) {
                Logger.error('Error al eliminar sesión', error);
                displayResult('Error al eliminar la sesión', true);
            }
        },

        // Limpiar todo el historial
        clearAllHistory: function() {
            PalletManager.showConfirmation(
                'Limpiar Historial',
                '¿Está seguro de eliminar todo el historial? Esta acción no se puede deshacer.',
                () => {
                    PersistenceManager.clearHistory();
                    this.renderHistory();
                    displayResult('Historial limpiado completamente', false);
                    Logger.log('Historial completo limpiado');
                }
            );
        }
    };

    // Modal para detalles de sesión mejorado
    const SessionDetailModal = {
        show: function(session) {
            const modal = document.getElementById('sessionDetailModal');
            if (!modal) {
                Logger.error('Modal de detalles de sesión no encontrado');
                return;
            }

            const modalBody = modal.querySelector('.modal-body');
            if (!modalBody) {
                Logger.error('Modal body no encontrado');
                return;
            }
            
            try {
                const date = new Date(session.timestamp);
                const dateStr = date.toLocaleDateString('es-ES', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });

                const summary = session.summary || { total: 0, found: 0, notFound: 0, withCounts: 0 };
                const pallets = session.pallets || [];

                modalBody.innerHTML = `
                    <div class="session-detail-header">
                        <h4>Sesión del ${dateStr}</h4>
                        <div class="session-summary-cards">
                            <div class="summary-card">
                                <div class="summary-card-number">${summary.total}</div>
                                <div class="summary-card-label">Total Pallets</div>
                            </div>
                            <div class="summary-card found">
                                <div class="summary-card-number">${summary.found}</div>
                                <div class="summary-card-label">Encontrados</div>
                            </div>
                            <div class="summary-card not-found">
                                <div class="summary-card-number">${summary.notFound}</div>
                                <div class="summary-card-label">No Encontrados</div>
                            </div>
                            <div class="summary-card counted">
                                <div class="summary-card-number">${summary.withCounts}</div>
                                <div class="summary-card-label">Con Conteo</div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="session-pallets-list">
                        <h5>Pallets en esta sesión:</h5>
                        ${pallets.map((pallet, index) => {
                            let statusClass = 'status-noencontrado';
                            let statusText = 'NO ENCONTRADO';
                            
                            if (pallet.found) {
                                statusClass = `status-${(pallet.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-')}`;
                                statusText = (pallet.statusSummary || 'Mixto').toUpperCase();
                            }
                            
                            const productsWithCount = pallet.products ? 
                                pallet.products.filter(p => p.cantidadContada !== undefined).length : 0;
                            const totalProducts = pallet.products ? pallet.products.length : 0;
                            
                            return `
                                <div class="session-pallet-item">
                                    <div class="pallet-item-header">
                                        <span class="pallet-number">${index + 1}.</span>
                                        <span class="pallet-id">${pallet.id || 'ID no disponible'}</span>
                                        <span class="${statusClass}">${statusText}</span>
                                    </div>
                                    ${totalProducts > 0 ? `
                                        <div class="pallet-item-progress">
                                            <span class="progress-text">Productos contados: ${productsWithCount}/${totalProducts}</span>
                                            <div class="progress-bar">
                                                <div class="progress-fill" style="width: ${totalProducts > 0 ? (productsWithCount/totalProducts)*100 : 0}%"></div>
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
                
                PalletManager.openModal(modal);
            } catch (error) {
                Logger.error('Error al mostrar detalles de sesión', error);
                modalBody.innerHTML = '<p class="error">Error al cargar los detalles de la sesión</p>';
                PalletManager.openModal(modal);
            }
        }
    };

    // Función mejorada para sanitizar IDs
    function getSafeId(text) {
        return window.InventorySystem.Utils.sanitizeId(text);
    }

    // Objeto mejorado para manejar modales y pallets
    const PalletManager = {
        elements: {},
        initialized: false,
        
        init: function() {
            if (this.initialized) return;
            
            try {
                // Obtener elementos del DOM
                this.elements = {
                    addPalletModal: document.getElementById('addPalletModal'),
                    closeAddPalletModal: document.getElementById('closeAddPalletModal'),
                    notFoundPalletId: document.getElementById('notFoundPalletId'),
                    newPalletId: document.getElementById('newPalletId'),
                    addPalletForm: document.getElementById('addPalletForm'),
                    newProductsList: document.getElementById('newProductsList'),
                    addProductButton: document.getElementById('addProductButton'),
                    cancelAddPallet: document.getElementById('cancelAddPallet'),
                    
                    confirmationModal: document.getElementById('confirmationModal'),
                    closeConfirmationModal: document.getElementById('closeConfirmationModal'),
                    confirmationTitle: document.getElementById('confirmationTitle'),
                    confirmationMessage: document.getElementById('confirmationMessage'),
                    cancelConfirmationButton: document.getElementById('cancelConfirmationButton'),
                    confirmConfirmationButton: document.getElementById('confirmConfirmationButton'),

                    editPalletModal: document.getElementById('editPalletModal'),
                    closeEditPalletModal: document.getElementById('closeEditPalletModal'),
                    editPalletForm: document.getElementById('editPalletForm'),
                    editPalletId: document.getElementById('editPalletId'),
                    editProductsList: document.getElementById('editProductsList'),
                    addEditProductButton: document.getElementById('addEditProductButton'),
                    cancelEditPallet: document.getElementById('cancelEditPallet'),

                    sessionDetailModal: document.getElementById('sessionDetailModal'),
                    closeSessionDetailModal: document.getElementById('closeSessionDetailModal'),

                    // NUEVOS ELEMENTOS PARA MODAL DE CONFIRMACIÓN DE ESCANEO
                    scanConfirmationModal: document.getElementById('scanConfirmationModal'),
                    closeScanConfirmationModal: document.getElementById('closeScanConfirmationModal'),
                    scannedCodeDisplay: document.getElementById('scannedCodeDisplay'),
                    rescanButton: document.getElementById('rescanButton'),
                    confirmScanButton: document.getElementById('confirmScanButton')
                };

                this.attachEventListeners();
                this.initialized = true;
                Logger.log('PalletManager inicializado correctamente');
            } catch (error) {
                Logger.error('Error al inicializar PalletManager', error);
            }
        },

        attachEventListeners: function() {
            // Event listeners para agregar pallet
            if (this.elements.closeAddPalletModal) {
                this.elements.closeAddPalletModal.addEventListener('click', () => {
                    this.closeModal(this.elements.addPalletModal);
                });
            }
            
            if (this.elements.addPalletForm) {
                this.elements.addPalletForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.handleAddPalletSubmit();
                });
            }
            
            if (this.elements.addProductButton) {
                this.elements.addProductButton.addEventListener('click', () => {
                    this.addProductEntry();
                });
            }
            
            if (this.elements.cancelAddPallet) {
                this.elements.cancelAddPallet.addEventListener('click', () => {
                    this.closeModal(this.elements.addPalletModal);
                });
            }

            // Event listeners para modal de edición
            if (this.elements.closeEditPalletModal) {
                this.elements.closeEditPalletModal.addEventListener('click', () => {
                    this.closeModal(this.elements.editPalletModal);
                });
            }

            if (this.elements.editPalletForm) {
                this.elements.editPalletForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.handleEditPalletSubmit();
                });
            }

            if (this.elements.addEditProductButton) {
                this.elements.addEditProductButton.addEventListener('click', () => {
                    this.addEditProductEntry();
                });
            }

            if (this.elements.cancelEditPallet) {
                this.elements.cancelEditPallet.addEventListener('click', () => {
                    this.closeModal(this.elements.editPalletModal);
                });
            }

            // Event listeners para modal de detalles de sesión
            if (this.elements.closeSessionDetailModal) {
                this.elements.closeSessionDetailModal.addEventListener('click', () => {
                    this.closeModal(this.elements.sessionDetailModal);
                });
            }
            
            // Delegar eventos para botones dinámicos - Agregar pallet
            if (this.elements.newProductsList) {
                this.elements.newProductsList.addEventListener('click', (e) => {
                    if (e.target.classList.contains('remove-product-btn')) {
                        const productEntries = this.elements.newProductsList.querySelectorAll('.product-entry');
                        if (productEntries.length > 1) {
                            e.target.closest('.product-entry').remove();
                        } else {
                            displayResult('Debe haber al menos un producto en el pallet.', true);
                        }
                    }
                });
            }

            // Delegar eventos para botones dinámicos - Editar pallet
            if (this.elements.editProductsList) {
                this.elements.editProductsList.addEventListener('click', (e) => {
                    if (e.target.classList.contains('remove-product-btn')) {
                        const productEntries = this.elements.editProductsList.querySelectorAll('.product-entry');
                        if (productEntries.length > 1) {
                            e.target.closest('.product-entry').remove();
                        } else {
                            displayResult('Debe haber al menos un producto en el pallet.', true);
                        }
                    }
                });
            }
            
            // Event listeners para confirmación
            if (this.elements.closeConfirmationModal) {
                this.elements.closeConfirmationModal.addEventListener('click', () => {
                    this.closeModal(this.elements.confirmationModal);
                });
            }
            
            if (this.elements.cancelConfirmationButton) {
                this.elements.cancelConfirmationButton.addEventListener('click', () => {
                    this.closeModal(this.elements.confirmationModal);
                });
            }
            
            // NUEVOS EVENT LISTENERS PARA MODAL DE CONFIRMACIÓN DE ESCANEO
            if (this.elements.closeScanConfirmationModal) {
                this.elements.closeScanConfirmationModal.addEventListener('click', () => {
                    this.closeModal(this.elements.scanConfirmationModal);
                    if (scanning) Quagga.start(); // Reanudar escáner si estaba activo
                });
            }

            if (this.elements.rescanButton) {
                this.elements.rescanButton.addEventListener('click', () => {
                    this.closeModal(this.elements.scanConfirmationModal);
                    if (scanning) Quagga.start(); // Reanudar escáner
                    displayResult('Listo para re-escanear...', false);
                    lastScannedIdForTick = null; // Resetear para permitir escanear el mismo código si es necesario
                });
            }
            
            // Cerrar modales con clic fuera
            window.addEventListener('click', (e) => {
                if (e.target === this.elements.addPalletModal) {
                    this.closeModal(this.elements.addPalletModal);
                } else if (e.target === this.elements.confirmationModal) {
                    this.closeModal(this.elements.confirmationModal);
                } else if (e.target === this.elements.editPalletModal) {
                    this.closeModal(this.elements.editPalletModal);
                } else if (e.target === this.elements.sessionDetailModal) {
                    this.closeModal(this.elements.sessionDetailModal);
                } else if (e.target === this.elements.scanConfirmationModal) { // NUEVO
                    this.closeModal(this.elements.scanConfirmationModal);
                    if (scanning) Quagga.start(); // Reanudar escáner
                }
            });
            
            // Tecla ESC para cerrar modales
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.closeModal(this.elements.addPalletModal);
                    this.closeModal(this.elements.confirmationModal);
                    this.closeModal(this.elements.editPalletModal);
                    this.closeModal(this.elements.sessionDetailModal);
                    this.closeModal(this.elements.scanConfirmationModal); // NUEVO
                    if (this.elements.scanConfirmationModal && !this.elements.scanConfirmationModal.classList.contains('hidden') && scanning) {
                         Quagga.start(); // Reanudar escáner
                    }
                }
            });
        },
        
        openModal: function(modalElement) {
            if (!modalElement) {
                Logger.warn('Intento de abrir modal nulo');
                return;
            }
            
            try {
                modalElement.classList.add('show');
                document.body.style.overflow = 'hidden';
                Logger.debug('Modal abierto', { modal: modalElement.id });
            } catch (error) {
                Logger.error('Error al abrir modal', error);
            }
        },
        
        closeModal: function(modalElement) {
            if (!modalElement) return;
            
            try {
                modalElement.classList.remove('show');
                document.body.style.overflow = '';
                Logger.debug('Modal cerrado', { modal: modalElement.id });
            } catch (error) {
                Logger.error('Error al cerrar modal', error);
            }
        },
        
        showAddPalletModal: function(palletId) {
            this.resetAddPalletForm();
            
            if (this.elements.notFoundPalletId) {
                this.elements.notFoundPalletId.textContent = palletId || 'ID no disponible';
            }
            if (this.elements.newPalletId) {
                this.elements.newPalletId.value = palletId || '';
            }
            
            this.openModal(this.elements.addPalletModal);
        },

        // Mostrar modal de edición
        showEditPalletModal: function(palletId) {
            const palletData = scannedPalletsSessionData.find(p => p.id === palletId);
            if (!palletData) {
                displayResult('Pallet no encontrado en la sesión', true);
                return;
            }

            this.populateEditForm(palletData);
            this.openModal(this.elements.editPalletModal);
        },

        // Poblar formulario de edición
        populateEditForm: function(palletData) {
            if (this.elements.editPalletId) {
                this.elements.editPalletId.value = palletData.id || '';
            }

            // Limpiar productos existentes
            if (this.elements.editProductsList) {
                this.elements.editProductsList.innerHTML = '';

                // Agregar productos del pallet
                if (palletData.products && Array.isArray(palletData.products)) {
                    palletData.products.forEach(product => {
                        const productEntry = this.createEditProductEntry(product);
                        this.elements.editProductsList.appendChild(productEntry);
                    });
                } else {
                    // Si no hay productos, agregar uno vacío
                    const productEntry = this.createEditProductEntry();
                    this.elements.editProductsList.appendChild(productEntry);
                }
            }
        },

        // Crear entrada de producto para edición
        createEditProductEntry: function(product = {}) {
            const productEntry = document.createElement('div');
            productEntry.className = 'product-entry';
            
            productEntry.innerHTML = `
                <div class="form-row">
                    <div class="form-group">
                        <label>Código de Artículo:</label>
                        <input type="text" class="product-code" value="${product["Código de artículo"] || ''}" required>
                    </div>
                    <div class="form-group">
                        <label>Nombre del Producto:</label>
                        <input type="text" class="product-name" value="${product["Nombre del producto"] || ''}" required>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Inventario Físico:</label>
                        <input type="number" class="product-quantity" value="${product["Inventario físico"] || ''}" required min="0" step="0.01">
                    </div>
                    <div class="form-group">
                        <label>Almacén:</label>
                        <input type="text" class="product-warehouse" value="${product["Almacén"] || ''}" required>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Física Disponible:</label>
                        <input type="number" class="product-available" value="${product["Física disponible"] || ''}" min="0" step="0.01">
                    </div>
                    <div class="form-group">
                        <label>Cantidad Contada:</label>
                        <input type="number" class="product-counted" value="${product.cantidadContada || ''}" min="0" step="0.01">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Número de Serie:</label>
                        <input type="text" class="product-serial" value="${product["Número de serie"] || ''}">
                    </div>
                </div>
                <button type="button" class="remove-product-btn">&times;</button>
            `;

            return productEntry;
        },

        // Agregar entrada de producto en edición
        addEditProductEntry: function() {
            if (!this.elements.editProductsList) return;
            
            const newProduct = this.createEditProductEntry();
            this.elements.editProductsList.appendChild(newProduct);
            newProduct.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },

        // Manejar envío de formulario de edición
        handleEditPalletSubmit: async function() {
            if (!this.validateEditPalletForm()) {
                return;
            }

            try {
                const formData = this.collectEditFormData();
                const palletIndex = scannedPalletsSessionData.findIndex(p => p.id === formData.palletId);
                
                if (palletIndex === -1) {
                    throw new Error('Pallet no encontrado en la sesión');
                }

                // Actualizar datos en la sesión
                scannedPalletsSessionData[palletIndex] = formData.palletData;

                // Guardar en localStorage
                if (!PersistenceManager.saveSessionData(scannedPalletsSessionData)) {
                    Logger.warn('No se pudo guardar en localStorage');
                }

                // Actualizar UI
                updateSessionScannedList();
                displayResult(`Pallet ${formData.palletId} editado correctamente.`, false);

                // Mostrar resumen si es el pallet actual
                displayPalletSummary(formData.palletData);

                this.closeModal(this.elements.editPalletModal);

            } catch (error) {
                Logger.error('Error al editar pallet', error);
                displayResult(`Error al editar pallet: ${error.message}`, true);
            }
        },

        // Validar formulario de edición
        validateEditPalletForm: function() {
            if (!this.elements.editProductsList) return false;
            
            const products = this.elements.editProductsList.querySelectorAll('.product-entry');
            if (products.length === 0) {
                displayResult('Debe tener al menos un producto en el pallet.', true);
                return false;
            }

            let isValid = true;
            const requiredInputs = this.elements.editPalletForm.querySelectorAll('[required]');
            requiredInputs.forEach(input => {
                if (!input.value.trim()) {
                    input.classList.add('error');
                    isValid = false;
                } else {
                    input.classList.remove('error');
                }
            });

            if (!isValid) {
                displayResult('Complete todos los campos requeridos.', true);
            }

            return isValid;
        },

        // Recopilar datos del formulario de edición
        collectEditFormData: function() {
            const palletId = this.elements.editPalletId.value;
            
            const products = [];
            const productEntries = this.elements.editProductsList.querySelectorAll('.product-entry');
            
            productEntries.forEach(entry => {
                const product = {
                    "Código de artículo": entry.querySelector('.product-code').value,
                    "Nombre del producto": entry.querySelector('.product-name').value,
                    "Inventario físico": entry.querySelector('.product-quantity').value,
                    "Almacén": entry.querySelector('.product-warehouse').value,
                };
                
                const disponible = entry.querySelector('.product-available').value;
                if (disponible) {
                    product["Física disponible"] = disponible;
                }
                
                const serial = entry.querySelector('.product-serial').value;
                if (serial) {
                    product["Número de serie"] = serial;
                }

                const counted = entry.querySelector('.product-counted').value;
                if (counted) {
                    product.cantidadContada = parseFloat(counted);
                }
                
                products.push(product);
            });

            const palletData = {
                id: palletId,
                found: true,
                products: products,
                statusSummary: 'Editado',
                isManuallyEdited: true
            };

            return {
                palletId: palletId,
                palletData: palletData
            };
        },
        
        resetAddPalletForm: function() {
            if (this.elements.addPalletForm) {
                this.elements.addPalletForm.reset();
            }
            
            if (this.elements.newProductsList) {
                const firstProduct = this.elements.newProductsList.querySelector('.product-entry');
                this.elements.newProductsList.innerHTML = '';
                
                if (firstProduct) {
                    const productTemplate = firstProduct.cloneNode(true);
                    const inputs = productTemplate.querySelectorAll('input');
                    inputs.forEach(input => {
                        input.value = '';
                        input.classList.remove('error');
                    });
                    this.elements.newProductsList.appendChild(productTemplate);
                }
            }
        },
        
        addProductEntry: function() {
            if (!this.elements.newProductsList) return;
            
            const firstProduct = this.elements.newProductsList.querySelector('.product-entry');
            if (!firstProduct) return;
            
            const newProduct = firstProduct.cloneNode(true);
            const inputs = newProduct.querySelectorAll('input');
            inputs.forEach(input => {
                input.value = '';
                input.classList.remove('error');
            });
            
            this.elements.newProductsList.appendChild(newProduct);
            newProduct.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
        
        handleAddPalletSubmit: async function() {
            if (!this.validateAddPalletForm()) {
                return;
            }
            
            try {
                loadingIndicator.classList.remove('hidden');
                
                const formData = this.collectFormData();
                const result = await this.saveNewPallet(formData);
                
                if (result && result.success) {
                    displayResult(`Pallet ${formData.palletId} agregado correctamente al inventario.`, false);
                    this.closeModal(this.elements.addPalletModal);
                    
                    scannedPalletsSessionData.push(formData.palletData);
                    
                    // Guardar en localStorage
                    PersistenceManager.saveSessionData(scannedPalletsSessionData);
                    
                    displayPalletSummary(formData.palletData);
                    updateSessionScannedList();
                    
                    Logger.log('Nuevo pallet agregado', { id: formData.palletId });
                } else {
                    throw new Error(result.error || 'Error desconocido al guardar el pallet.');
                }
                
            } catch (error) {
                Logger.error('Error al guardar nuevo pallet', error);
                displayResult(`Error al guardar el pallet: ${error.message}`, true);
            } finally {
                loadingIndicator.classList.add('hidden');
            }
        },
        
        validateAddPalletForm: function() {
            if (!this.elements.newProductsList) return false;
            
            const products = this.elements.newProductsList.querySelectorAll('.product-entry');
            if (products.length === 0) {
                displayResult('Debe agregar al menos un producto al pallet.', true);
                return false;
            }
            
            let isValid = true;
            const requiredInputs = this.elements.addPalletForm.querySelectorAll('[required]');
            requiredInputs.forEach(input => {
                if (!input.value.trim()) {
                    input.classList.add('error');
                    isValid = false;
                } else {
                    input.classList.remove('error');
                }
            });
            
            if (!isValid) {
                displayResult('Complete todos los campos requeridos.', true);
            }
            
            return isValid;
        },
        
        collectFormData: function() {
            const palletId = this.elements.newPalletId.value;
            const statusSummary = this.elements.addPalletForm.querySelector('#newPalletStatus').value;
            
            const products = [];
            const productEntries = this.elements.newProductsList.querySelectorAll('.product-entry');
            
            productEntries.forEach(entry => {
                const product = {
                    "Código de artículo": entry.querySelector('.product-code').value,
                    "Nombre del producto": entry.querySelector('.product-name').value,
                    "Inventario físico": entry.querySelector('.product-quantity').value,
                    "Almacén": entry.querySelector('.product-warehouse').value,
                };
                
                const disponible = entry.querySelector('.product-available').value;
                if (disponible) {
                    product["Física disponible"] = disponible;
                }
                
                const serial = entry.querySelector('.product-serial').value;
                if (serial) {
                    product["Número de serie"] = serial;
                }
                
                products.push(product);
            });
            
            const palletData = {
                id: palletId,
                found: true,
                products: products,
                statusSummary: statusSummary + ' (Manual)',
                isManuallyAdded: true
            };
            
            return {
                palletId: palletId,
                statusSummary: statusSummary,
                products: products,
                palletData: palletData
            };
        },
        
        saveNewPallet: async function(formData) {
            try {
                // Simular guardado (aquí podrías hacer una llamada real al servidor)
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                return {
                    success: true,
                    message: "Pallet agregado manualmente a la sesión",
                    palletData: formData.palletData
                };
            } catch (error) {
                Logger.error('Error en saveNewPallet', error);
                throw error;
            }
        },
        
        // Mostrar confirmación genérica
        showConfirmation: function(title, message, onConfirm) {
            if (!this.elements.confirmationTitle || !this.elements.confirmationMessage) {
                Logger.error('Elementos de confirmación no encontrados');
                return;
            }
            
            this.elements.confirmationTitle.textContent = title;
            this.elements.confirmationMessage.textContent = message;
            
            if (this.elements.confirmConfirmationButton) {
                this.elements.confirmConfirmationButton.onclick = () => {
                    this.closeModal(this.elements.confirmationModal);
                    if (typeof onConfirm === 'function') {
                        onConfirm();
                    }
                };
            }
            
            this.openModal(this.elements.confirmationModal);
        },

        confirmDeletePallet: function(palletId, callback) {
            this.showConfirmation(
                'Eliminar Pallet',
                `¿Está seguro de eliminar el pallet ${palletId} de la sesión?`,
                callback
            );
        },

        // NUEVA FUNCIÓN: Mostrar modal de confirmación de escaneo
        showScanConfirmation: function(scannedCode) {
            if (!this.elements.scanConfirmationModal || !this.elements.scannedCodeDisplay || !this.elements.confirmScanButton) {
                Logger.error('Elementos del modal de confirmación de escaneo no encontrados');
                return;
            }

            this.elements.scannedCodeDisplay.textContent = scannedCode;

            // Limpiar listener anterior para evitar duplicados
            const oldConfirmListener = this.elements.confirmScanButton.onclick;
            if (oldConfirmListener) {
                this.elements.confirmScanButton.removeEventListener('click', oldConfirmListener);
            }
            
            this.elements.confirmScanButton.onclick = async () => {
                this.closeModal(this.elements.scanConfirmationModal);
                await checkPalletId(scannedCode, true); // Pasar `true` para indicar que viene de escaneo
                if (scanning) Quagga.start(); // Reanudar escáner después de la búsqueda
            };

            this.openModal(this.elements.scanConfirmationModal);
        }
    };

    // Funciones de UI mejoradas
    function displayResult(message, isError = false) {
        if (!resultDisplay) return;
        
        resultDisplay.innerHTML = `<p class="${isError ? 'error' : 'success'}">${message}</p>`;
        Logger.debug('Resultado mostrado', { message, isError });
    }

    function displayPalletSummary(palletData) {
        if (!palletSummary) return;
        
        palletSummary.innerHTML = ''; 
        
        if (!palletData) {
            palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
            return;
        }
        
        try {
            if (palletData.found && palletData.products && palletData.products.length > 0) {
                let statusColorClass = (palletData.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-');
                let html = `<div class="pallet-summary-header">
                                <h4>ID Pallet: <span class="highlight">${palletData.id}</span></h4>
                                <button class="btn-icon edit-pallet-btn" title="Editar pallet" onclick="PalletManager.showEditPalletModal('${palletData.id}')">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                    </svg>
                                </button>
                            </div>`;
                html += `<p><strong>Estado General (Sistema):</strong> <span class="status-${statusColorClass}">${(palletData.statusSummary || 'Mixto').toUpperCase()}</span></p>`;
                html += `<p><strong>Productos en Pallet (Sistema): ${palletData.products.length}</strong></p>`;
                html += '<ul>';
                
                palletData.products.forEach((product, index) => {
                    const systemQuantity = product["Inventario físico"];
                    const systemQuantityFormatted = (systemQuantity !== undefined && systemQuantity !== '') 
                        ? window.InventorySystem.Utils.formatNumber(systemQuantity) 
                        : 'N/A';
                    
                    const productCode = product["Código de artículo"] 
                        ? getSafeId(product["Código de artículo"]) 
                        : `item-${index}-${Date.now()}`;
                    
                    const almacen = product["Almacén"] || 'N/A';
                    const nombre = product["Nombre del producto"] || 'N/A';
                    const codigoArticulo = product["Código de artículo"] || 'N/A';
                    const disponible = product["Física disponible"];
                    const disponibleFormatted = (disponible !== undefined && disponible !== '') 
                        ? window.InventorySystem.Utils.formatNumber(disponible) 
                        : 'N/A';
                    const numSerie = product["Número de serie"] || '';
                    
                    html += `<li>
                                <strong>Cód. Artículo:</strong> ${codigoArticulo}<br> 
                                <strong>Nombre:</strong> ${nombre}<br>
                                <strong>Inv. Sist.:</strong> <span class="quantity">${systemQuantityFormatted}</span> | 
                                <strong>Disp. Sist.:</strong> ${disponibleFormatted}<br>
                                <strong>Almacén:</strong> ${almacen}
                                ${numSerie ? `| <strong>Nº Serie:</strong> ${numSerie}` : ''}<br>
                                <label for="counted-${productCode}-${palletData.id}">Cant. Contada:</label>
                                <input type="number" min="0" id="counted-${productCode}-${palletData.id}" class="counted-quantity-input" 
                                       data-pallet-id="${palletData.id}" data-product-index="${index}" placeholder="Físico" 
                                       value="${product.cantidadContada !== undefined ? product.cantidadContada : ''}">
                                <span id="diff-${productCode}-${palletData.id}" class="quantity-diff"></span>
                             </li>`;
                });
                
                html += '</ul>';
                palletSummary.innerHTML = html;
                attachQuantityChangeListeners();
                
            } else if (palletData.id && palletData.found) {
                 palletSummary.innerHTML = `<p>Pallet <span class="highlight">${palletData.id}</span> encontrado, pero sin productos detallados o columnas vacías. Estado: ${palletData.statusSummary || 'Desconocido'}</p>`;
            } else if (palletData.id && !palletData.found) {
                 palletSummary.innerHTML = `<p>Pallet <span class="highlight">${palletData.id}</span> NO ENCONTRADO en inventario maestro.</p>`;
            } else {
                palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
            }
        } catch (error) {
            Logger.error('Error al mostrar resumen de pallet', error);
            palletSummary.innerHTML = '<p class="error">Error al mostrar el resumen del pallet</p>';
        }
    }

    function attachQuantityChangeListeners() {
        document.querySelectorAll('.counted-quantity-input').forEach(input => {
            // Remover listener previo para evitar duplicados
            input.removeEventListener('input', handleQuantityChange); 
            input.addEventListener('input', handleQuantityChange);
            
            input.addEventListener('focus', function() {
                this.select();
            });
        });
    }

    function handleQuantityChange(e) {
        const countedInput = e.target.value;
        const palletId = e.target.dataset.palletId;
        const productIndex = parseInt(e.target.dataset.productIndex, 10);

        if (isNaN(productIndex) || !palletId) {
            Logger.error('Datos inválidos en input de cantidad', { palletId, productIndex });
            return;
        }

        const palletSessionEntry = scannedPalletsSessionData.find(p => p.id === palletId);
        if (!palletSessionEntry || !palletSessionEntry.products || !palletSessionEntry.products[productIndex]) {
            Logger.error('No se encontró el producto en la sesión', { palletId, productIndex });
            return;
        }
        
        const productInfo = palletSessionEntry.products[productIndex];
        
        if (countedInput === '' || countedInput === null) {
             delete productInfo.cantidadContada;
        } else {
            const counted = parseFloat(countedInput);
            if (!isNaN(counted)) {
                productInfo.cantidadContada = counted; 
            } else {
                delete productInfo.cantidadContada;
            }
        }
        
        // Actualizar diferencia visual
        try {
            const systemQty = parseFloat(productInfo["Inventario físico"]); 
            
            const safeProductCode = productInfo["Código de artículo"] 
                ? getSafeId(productInfo["Código de artículo"])
                : `item-${productIndex}-${Date.now()}`;
            
            const diffElementId = `diff-${safeProductCode}-${palletId}`;
            const diffElement = document.getElementById(diffElementId);

            if (diffElement) {
                if (productInfo.cantidadContada !== undefined && !isNaN(productInfo.cantidadContada) && !isNaN(systemQty)) {
                    const diff = productInfo.cantidadContada - systemQty;
                    diffElement.textContent = ` Dif: ${window.InventorySystem.Utils.formatNumber(diff)}`;
                    diffElement.className = 'quantity-diff ' + (diff === 0 ? 'ok' : 'discrepancy');
                } else if (productInfo.cantidadContada !== undefined && !isNaN(productInfo.cantidadContada)) { 
                    diffElement.textContent = ` (Contado: ${window.InventorySystem.Utils.formatNumber(productInfo.cantidadContada)})`;
                    diffElement.className = 'quantity-diff discrepancy';
                } else {
                    diffElement.textContent = '';
                    diffElement.className = 'quantity-diff';
                }
            }
        } catch (error) {
            Logger.error('Error al actualizar diferencia visual', error);
        }
        
        // Guardar cambios automáticamente
        PersistenceManager.saveSessionData(scannedPalletsSessionData);
        updateSessionScannedList();
    }
    
    function updateSessionScannedList() {
        if (!sessionScannedListElement) return;
        
        sessionScannedListElement.innerHTML = '';
        
        if (scannedPalletsSessionData.length > 0) {
            finishSessionButton.classList.remove('hidden');
        } else {
            finishSessionButton.classList.add('hidden');
        }

        scannedPalletsSessionData.forEach((palletInfo, index) => {
            const listItem = document.createElement('li');
            let statusColorClass = 'status-noencontrado';
            let statusTextDisplay = 'NO ENCONTRADO (SISTEMA)';

            if (palletInfo.found) {
                statusColorClass = `status-${(palletInfo.statusSummary || 'mixto').toLowerCase().replace(/\s+/g, '-')}`;
                statusTextDisplay = (palletInfo.statusSummary || 'Mixto').toUpperCase();
            }
            
            listItem.innerHTML = `
                <div class="session-item-content">
                    <div class="session-item-main">
                        <span class="pallet-index">${index + 1}.</span> 
                        ID: <span class="highlight">${palletInfo.id}</span> - 
                        Estado Sistema: <span class="${statusColorClass}">${statusTextDisplay}</span>
                    </div>
                    <div class="session-item-actions">
                        <button class="btn-icon view-pallet-btn" title="Ver detalles" onclick="displayPalletSummary(scannedPalletsSessionData[${index}])">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                <circle cx="12" cy="12" r="3"/>
                            </svg>
                        </button>
                        <button class="btn-icon edit-pallet-btn" title="Editar pallet" onclick="PalletManager.showEditPalletModal('${palletInfo.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="btn-icon delete-pallet-btn" title="Eliminar pallet" onclick="removePalletFromSession(${index})">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3,6 5,6 21,6"/>
                                <path d="M19,6V20a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `;
            
            if (palletInfo.found && palletInfo.products && palletInfo.products.length > 0) {
                let itemsConConteo = palletInfo.products.filter(p => p.cantidadContada !== undefined).length;
                const progressDiv = document.createElement('div');
                progressDiv.className = 'session-item-progress';
                progressDiv.innerHTML = `
                    <span class="count-progress">(${palletInfo.products.length} tipo(s) prod. sistema / 
                    <span class="${itemsConConteo === palletInfo.products.length ? 'count-complete' : 'count-incomplete'}">${itemsConConteo} contado(s)</span>)</span>
                `;
                listItem.appendChild(progressDiv);
            }
            
            sessionScannedListElement.appendChild(listItem);
        });
    }

    // Función global para remover pallet mejorada
    window.removePalletFromSession = function(index) {
        const pallet = scannedPalletsSessionData[index];
        if (!pallet) return;
        
        PalletManager.confirmDeletePallet(pallet.id, () => {
            scannedPalletsSessionData.splice(index, 1);
            PersistenceManager.saveSessionData(scannedPalletsSessionData);
            updateSessionScannedList();
            displayResult(`Pallet ${pallet.id} eliminado de la sesión`, false);
            
            // Limpiar resumen si era el pallet mostrado
            if (palletSummary && palletSummary.innerHTML.includes(pallet.id)) {
                palletSummary.innerHTML = '<p>Esperando escaneo o verificación...</p>';
            }
            
            Logger.log('Pallet eliminado de sesión', { id: pallet.id, index });
        });
    };

    // Función para verificar sesión al cargar mejorada
    function checkForPreviousSession() {
        if (PersistenceManager.hasRecentSession()) {
            const sessionData = PersistenceManager.loadSessionData();
            
            if (!sessionData) return;
            
            sessionRecoveryAlert.innerHTML = `
                <p><strong>Sesión anterior detectada</strong></p>
                <p>Se encontró una sesión no procesada con ${sessionData.pallets.length} pallet(s). 
                ¿Desea recuperarla?</p>
                <div class="recovery-actions">
                    <button id="recoverSessionButton" class="btn btn-primary">Recuperar Sesión</button>
                    <button id="discardSessionButton" class="btn btn-outline">Nueva Sesión</button>
                </div>
            `;
            sessionRecoveryAlert.classList.remove('hidden');
            
            // Event listeners para botones de recuperación
            const recoverBtn = document.getElementById('recoverSessionButton');
            const discardBtn = document.getElementById('discardSessionButton');
            
            if (recoverBtn) {
                recoverBtn.addEventListener('click', () => {
                    scannedPalletsSessionData = [...sessionData.pallets];
                    updateSessionScannedList();
                    sessionRecoveryAlert.classList.add('hidden');
                    displayResult(`Sesión recuperada con ${sessionData.pallets.length} pallet(s)`, false);
                    Logger.log('Sesión anterior recuperada', { pallets: sessionData.pallets.length });
                });
            }
            
            if (discardBtn) {
                discardBtn.addEventListener('click', () => {
                    PersistenceManager.clearSessionData();
                    sessionRecoveryAlert.classList.add('hidden');
                    displayResult('Nueva sesión iniciada', false);
                    Logger.log('Sesión anterior descartada');
                });
            }
        }
    }

    // Función de verificación de pallet mejorada
    async function checkPalletId(palletId, fromScan = false) {
        const validation = window.InventorySystem.Utils.validatePalletId(palletId);
        
        if (!validation.isValid) {
            displayResult(validation.error || 'ID de pallet inválido', true);
            return;
        }
        
        const trimmedPalletId = validation.value;
        
        if (isProcessingRequest) {
            displayResult('Procesando solicitud anterior, espere un momento...', true);
            return;
        }
        
        isProcessingRequest = true;
        
        loadingIndicator.classList.remove('hidden');
        resultDisplay.innerHTML = `<p>Verificando ID: <span class="highlight">${trimmedPalletId}</span>...</p>`;
        
        if (!fromScan) { 
            palletSummary.innerHTML = '';
        }

        const url = `${APPS_SCRIPT_URL}?idpallet=${encodeURIComponent(trimmedPalletId)}&apiKey=${encodeURIComponent(API_KEY_FOR_SCRIPT)}`;
        Logger.log("Enviando solicitud", { id: trimmedPalletId });

        try {
            if (!navigator.onLine) {
                throw new Error('Sin conexión a internet');
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            const dataFromServer = await response.json(); 
            loadingIndicator.classList.add('hidden');
            Logger.log("Respuesta recibida", dataFromServer);

            if (dataFromServer.error) {
                displayResult(`Error desde el servidor: ${dataFromServer.error}`, true);
                const palletInfoError = { 
                    id: trimmedPalletId, 
                    found: false, 
                    products: [], 
                    statusSummary: "Error Servidor" 
                };
                
                const existingErrorIndex = scannedPalletsSessionData.findIndex(
                    p => p.id === trimmedPalletId && p.statusSummary === "Error Servidor"
                );
                
                if (existingErrorIndex === -1) {
                    scannedPalletsSessionData.push(palletInfoError);
                    PersistenceManager.saveSessionData(scannedPalletsSessionData);
                }
            } else {
                if (!dataFromServer.found) {
                    const palletInfoNotFound = { 
                        id: trimmedPalletId, 
                        found: false, 
                        products: [], 
                        statusSummary: "No Encontrado" 
                    };
                    
                    const existingNotFoundIndex = scannedPalletsSessionData.findIndex(
                        p => p.id === trimmedPalletId && !p.found
                    );
                    
                    if (existingNotFoundIndex === -1) {
                        scannedPalletsSessionData.push(palletInfoNotFound);
                        PersistenceManager.saveSessionData(scannedPalletsSessionData);
                    }
                    
                    displayResult(`Pallet ID: ${trimmedPalletId} NO ENCONTRADO en el inventario.`, true);
                    displayPalletSummary(palletInfoNotFound);
                    
                    PalletManager.showAddPalletModal(trimmedPalletId);
                } else {
                    const palletInfoForSession = {
                        id: dataFromServer.id,
                        found: dataFromServer.found,
                        products: (dataFromServer.products || []).map(p_sistema => ({ 
                            ...p_sistema, 
                            cantidadContada: undefined 
                        })),
                        statusSummary: dataFromServer.statusSummary || (dataFromServer.found ? "Mixto" : "No Encontrado")
                    };

                    const existingEntryIndex = scannedPalletsSessionData.findIndex(p => p.id === palletInfoForSession.id);
                    
                    if (existingEntryIndex > -1) {
                        const existingEntry = scannedPalletsSessionData[existingEntryIndex];
                        
                        // Preservar cantidades contadas previas
                        palletInfoForSession.products.forEach((newProdInfo, newProdIndex) => {
                            const existingProdInfo = existingEntry.products.find(
                                ep => ep["Código de artículo"] === newProdInfo["Código de artículo"]
                            );
                            
                            if (existingProdInfo && existingProdInfo.cantidadContada !== undefined) {
                                newProdInfo.cantidadContada = existingProdInfo.cantidadContada;
                            }
                        });
                        
                        scannedPalletsSessionData[existingEntryIndex] = palletInfoForSession;
                        displayResult(`Pallet ID: ${palletInfoForSession.id} RE-VERIFICADO. Estado Sistema: ${palletInfoForSession.statusSummary}.`, !palletInfoForSession.found);
                    } else {
                        scannedPalletsSessionData.push(palletInfoForSession);
                        displayResult(`Pallet ID: ${palletInfoForSession.id} ${palletInfoForSession.found ? 'ENCONTRADO' : 'NO ENCONTRADO'}. Estado Sistema: ${palletInfoForSession.statusSummary}. Añadido a la sesión.`, !palletInfoForSession.found);
                    }
                    
                    // Guardar automáticamente
                    PersistenceManager.saveSessionData(scannedPalletsSessionData);
                    
                    displayPalletSummary(palletInfoForSession);
                }
                
                updateSessionScannedList();
            }
            
        } catch (error) {
            Logger.error('Error al verificar pallet', error);
            
            let errorMessage = 'Error de conexión o al procesar la solicitud.';
            if (error.name === 'AbortError') {
                errorMessage = 'La solicitud tardó demasiado. Verifique su conexión e intente nuevamente.';
            }
            
            displayResult(errorMessage, true);
            loadingIndicator.classList.add('hidden');
            
            const palletInfoError = { 
                id: trimmedPalletId, 
                found: false, 
                products: [], 
                statusSummary: "Error Conexión" 
            };
            
            const existingErrorIndex = scannedPalletsSessionData.findIndex(
                p => p.id === trimmedPalletId && p.statusSummary === "Error Conexión"
            );
            
            if (existingErrorIndex === -1) {
                scannedPalletsSessionData.push(palletInfoError);
                PersistenceManager.saveSessionData(scannedPalletsSessionData);
            }
            
            updateSessionScannedList();
            
        } finally {
            isProcessingRequest = false;
        }
    }

    // Funciones del escáner mejoradas
    function adjustScannerLayout() {
        if (!video || !scannerContainer || !canvasElement) return;
        
        try {
            const containerWidth = Math.min(window.innerWidth - 30, 500);
            scannerContainer.style.width = containerWidth + 'px';
            scannerContainer.style.height = 'auto';
            
            video.onloadedmetadata = function() {
                if (video.videoWidth && video.videoHeight) {
                    const videoRatio = video.videoWidth / video.videoHeight;
                    const containerHeight = containerWidth / videoRatio;
                    
                    scannerContainer.style.height = containerHeight + 'px';
                    video.style.width = '100%';
                    video.style.height = '100%';
                    video.style.objectFit = 'cover';
                    
                    canvasElement.width = containerWidth;
                    canvasElement.height = containerHeight;
                    canvasElement.style.width = '100%';
                    canvasElement.style.height = '100%';
                    
                    Logger.log('Scanner layout adjusted', {
                        containerWidth,
                        containerHeight,
                        videoRatio
                    });
                }
            };
        } catch (error) {
            Logger.error('Error ajustando layout del escáner', error);
        }
    }

    function initQuagga() {
        if (!video || video.readyState === 0) {
            Logger.error('Video element not ready');
            return;
        }

        if (canvasElement && video.videoWidth && video.videoHeight) {
            canvasElement.width = video.videoWidth;
            canvasElement.height = video.videoHeight;
        }

        Quagga.init({
            inputStream: {
                name: "Live",
                type: "LiveStream",
                target: video,
                constraints: {
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    aspectRatio: { ideal: 16/9 },
                    facingMode: "environment" 
                },
                area: {
                    top: "20%",
                    right: "10%",
                    left: "10%",
                    bottom: "20%"
                },
            },
            locator: {
                patchSize: "medium",
                halfSample: true
            },
            numOfWorkers: Math.max(2, (navigator.hardwareConcurrency || 4) - 1),
            frequency: 10,
            decoder: {
                readers: [
                    "code_128_reader",
                    "ean_reader",
                    "ean_8_reader",
                    "code_39_reader",
                    "code_39_vin_reader",
                    "codabar_reader",
                    "upc_reader",
                    "upc_e_reader",
                    "i2of5_reader",
                    "2of5_reader",
                    "code_93_reader"
                ],
                multiple: false
            },
            locate: true
        }, function(err) {
            if (err) {
                Logger.error("Error iniciando Quagga:", err);
                displayResult("Error al iniciar el escáner: " + err, true);
                stopScanner();
                return;
            }
            
            Logger.log("Quagga iniciado correctamente");
            
            try {
                Quagga.start();
                quaggaScanner = true;
                
                Quagga.onDetected(handleQuaggaDetection);
                
                if (canvasElement && canvasContext) {
                    Quagga.onProcessed(function(result) {
                        if (!result || !canvasContext) return;
                        
                        canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
                        
                        if (result.boxes) {
                            const hasResult = result.boxes.filter(box => box !== result.box).length > 0;
                            
                            if (hasResult) {
                                result.boxes.forEach(function(box) {
                                    canvasContext.strokeStyle = "rgba(0, 255, 0, 0.5)";
                                    canvasContext.lineWidth = 2;
                                    canvasContext.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
                                });
                            }
                        }
                        
                        if (result.box) {
                            canvasContext.strokeStyle = "rgba(0, 0, 255, 0.8)";
                            canvasContext.lineWidth = 2;
                            canvasContext.strokeRect(
                                result.box.x, result.box.y,
                                result.box.width, result.box.height
                            );
                        }
                        
                        if (result.codeResult && result.codeResult.code) {
                            canvasContext.font = "16px Arial";
                            canvasContext.fillStyle = "#00cc00";
                            canvasContext.fillRect(0, 0, 220, 30);
                            canvasContext.fillStyle = "#000000";
                            canvasContext.fillText(`Código: ${result.codeResult.code}`, 10, 20);
                        }
                    });
                }
                
                canvasElement.classList.remove('hidden');
                displayResult("Escáner activo. Apunte al código del pallet.", false);
                
            } catch (startError) {
                Logger.error("Error al iniciar Quagga.start()", startError);
                displayResult("Error al iniciar el escáner. Intente de nuevo.", true);
                stopScanner();
            }
        });
    }

    function handleQuaggaDetection(result) {
        if (!result || !result.codeResult || !result.codeResult.code) return;
        
        const scannedCode = result.codeResult.code;
        Logger.log("Código detectado", scannedCode);
        
        // Solo procesar si es un código diferente al último detectado para evitar el "tick"
        // Y detener Quagga para que el usuario pueda confirmar sin más detecciones.
        if (scannedCode !== lastScannedIdForTick) {
            lastScannedIdForTick = scannedCode;
            
            // Pausar Quagga para permitir la interacción del usuario
            if (quaggaScanner) {
                Quagga.stop();
                Logger.log("Quagga pausado para confirmación.");
            }

            // Mostrar el modal de confirmación
            PalletManager.showScanConfirmation(scannedCode);
            
            // Limpiar el timeout si existe, ya no es necesario el debounce automático
            clearTimeout(scanDebounceTimeout);
            scanDebounceTimeout = null; 
        }
    }

    function startScanner() {
        if (palletSummary) palletSummary.innerHTML = ""; 
        if (resultDisplay) resultDisplay.innerHTML = "<p>Iniciando cámara...</p>";

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            displayResult("La función de escaneo no es soportada en este navegador.", true);
            return;
        }

        navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: "environment",
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                aspectRatio: { ideal: 16/9 }
            } 
        }).then(function(mediaStream) {
            stream = mediaStream;
            video.srcObject = mediaStream;
            video.setAttribute("playsinline", true);
            video.play();
            
            scanning = true;
            
            scannerContainer.classList.remove('hidden');
            startScanButton.classList.add('hidden');
            stopScanButton.classList.remove('hidden'); 
            
            if (resultDisplay) {
                resultDisplay.innerHTML = "<p>Cámara activa. Apunte al código del pallet.</p>";
            }
            lastScannedIdForTick = null; 
            
            adjustScannerLayout();
            
            video.onloadedmetadata = function() {
                adjustScannerLayout();
                setTimeout(() => {
                    initQuagga();
                }, 300);
            };
            
            Logger.log('Escáner iniciado correctamente');
            
        }).catch(function(err) {
            Logger.error("Error al acceder a la cámara", err);
            
            let errorMsg = "Error al acceder a la cámara";
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                errorMsg = "Permiso de cámara denegado. Por favor, permita el acceso a la cámara.";
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                errorMsg = "No se encontró ninguna cámara en este dispositivo.";
            }
            
            displayResult(errorMsg, true);
            stopScanner();
        });
    }

    function stopScanner() {
        Logger.log("Intentando detener el escáner...");
        
        try {
            scanning = false;
            
            if (quaggaScanner && typeof Quagga !== 'undefined') {
                try {
                    Quagga.offDetected(handleQuaggaDetection);
                    Logger.log("Event listeners de Quagga eliminados");
                } catch (listenerError) {
                    Logger.warn("Error al eliminar listeners de Quagga", listenerError);
                }
                
                try {
                    Quagga.stop();
                    Logger.log("Quagga detenido correctamente");
                } catch (stopError) {
                    Logger.error("Error al detener Quagga", stopError);
                }
                
                quaggaScanner = null;
            }
            
            if (stream) {
                try {
                    const tracks = stream.getTracks();
                    tracks.forEach(track => {
                        track.stop();
                        Logger.log(`Track de tipo ${track.kind} detenido`);
                    });
                } catch (trackError) {
                    Logger.error("Error al detener tracks de video", trackError);
                }
                stream = null;
            }
            
            if (video) {
                video.srcObject = null;
                video.onloadedmetadata = null;
            }
            
            scannerContainer.classList.add('hidden');
            if (canvasElement) canvasElement.classList.add('hidden');
            startScanButton.classList.remove('hidden');
            stopScanButton.classList.add('hidden'); 
            
            clearTimeout(scanDebounceTimeout);
            scanDebounceTimeout = null; // Asegurarse de limpiar el timeout
            
            Logger.log("Escáner detenido completamente");
            
        } catch (error) {
            Logger.error("Error general al detener el escáner", error);
            
            try {
                if (video) video.srcObject = null;
                scannerContainer.classList.add('hidden');
                if (canvasElement) canvasElement.classList.add('hidden');
                startScanButton.classList.remove('hidden');
                stopScanButton.classList.add('hidden');
                
                scanning = false;
                quaggaScanner = null;
                stream = null;
                
                Logger.warn("Se forzó la detención del escáner tras un error");
                
            } catch (e) {
                Logger.error("Error crítico durante limpieza de emergencia", e);
                alert("Error crítico. Por favor, recargue la página.");
            }
        }
    }

    async function finishAndProcessSession() {
        if (scannedPalletsSessionData.length === 0) {
            if (sessionResultDisplay) {
                sessionResultDisplay.innerHTML = "<p>No hay pallets escaneados en esta sesión para procesar.</p>";
            }
            return;
        }

        if (scanning) {
            stopScanner();
        }
        
        loadingIndicator.classList.remove('hidden');
        if (sessionResultDisplay) {
            sessionResultDisplay.innerHTML = "<p>Procesando sesión y enviando datos al servidor...</p>";
        }
        Logger.log("Iniciando procesamiento de sesión", { pallets: scannedPalletsSessionData.length });
    
        try {
            if (!navigator.onLine) {
                throw new Error("No hay conexión a internet. Verifique su conexión e intente nuevamente.");
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ 
                    apiKey: API_KEY_FOR_SCRIPT,
                    action: 'processSessionWithQuantities',
                    sessionData: scannedPalletsSessionData 
                }),
                signal: controller.signal,
                redirect: 'follow' 
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text(); 
                throw new Error(`Error de servidor: ${response.status} ${response.statusText}. Respuesta: ${errorText}`);
            }
            
            const result = await response.json(); 
            loadingIndicator.classList.add('hidden');
            Logger.log("Respuesta de procesamiento de sesión", result);

            if (result.error) {
                if (sessionResultDisplay) {
                    sessionResultDisplay.innerHTML = `<p class="error">Error al procesar sesión: ${result.error}</p>`;
                }
            } else if (result.success) {
                let summaryHtml = `<p>Pallets Procesados: ${result.summary.palletsProcesados || 0}</p>
                                   <p>Items Procesados: ${result.summary.itemsProcesados || 0}</p>
                                   <p>Items OK (Conteo = Sistema): ${result.summary.itemsOk || 0}</p>
                                   <p>Items con Discrepancia: ${result.summary.itemsConDiscrepancia || 0}</p>`;
                
                const logSheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID_FOR_LOG_LINK}/edit#gid=${LOG_SHEET_GID_FOR_LOG_LINK}`;

                if (sessionResultDisplay) {
                    sessionResultDisplay.innerHTML = `<p class="success">${result.message}</p> 
                                                    ${summaryHtml}
                                                    <p><a href="${logSheetUrl}" target="_blank">Ver Hoja de Resultados del Log</a></p>`;
                }
                
                // Guardar en historial antes de limpiar
                PersistenceManager.saveToHistory(scannedPalletsSessionData);
                
                // Limpiar datos
                scannedPalletsSessionData = [];
                PersistenceManager.clearSessionData();
                updateSessionScannedList();
                if (resultDisplay) {
                    resultDisplay.innerHTML = "<p>Sesión procesada. Puede iniciar una nueva.</p>";
                }
                if (palletSummary) {
                    palletSummary.innerHTML = "";
                }
                
                Logger.log('Sesión procesada exitosamente', result.summary);
            } else {
                if (sessionResultDisplay) {
                    sessionResultDisplay.innerHTML = `<p class="error">Respuesta inesperada del servidor al procesar sesión.</p>`;
                }
            }

        } catch (error) {
            Logger.error('Error al finalizar sesión', error);
            loadingIndicator.classList.add('hidden');
            
            let errorMessage = error.message;
            if (error.name === 'AbortError') {
                errorMessage = "La solicitud tomó demasiado tiempo. El servidor podría estar ocupado.";
            }
            
            if (sessionResultDisplay) {
                sessionResultDisplay.innerHTML = `<p class="error">Error de conexión al finalizar sesión: ${errorMessage}</p>`;
            }
        }
    }

    // Event Listeners mejorados
    function attachMainEventListeners() {
        if (startScanButton) {
            startScanButton.addEventListener('click', function(e) {
                e.preventDefault();
                if (scanning) return;
                startScanner();
            });
        }
        
        if (stopScanButton) {
            stopScanButton.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                
                stopScanButton.disabled = true;
                stopScanner();
                
                setTimeout(() => {
                    stopScanButton.disabled = false;
                }, 1000);
            });
        }
        
        if (checkManualButton) {
            checkManualButton.addEventListener('click', () => {
                if (manualPalletIdInput) {
                    checkPalletId(manualPalletIdInput.value.trim());
                }
            });
        }
        
        if (manualPalletIdInput) {
            manualPalletIdInput.addEventListener('keypress', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    checkPalletId(manualPalletIdInput.value.trim());
                }
            });
        }
        
        if (finishSessionButton) {
            finishSessionButton.addEventListener('click', finishAndProcessSession);
        }

        // Event listeners para historial
        if (historyToggleButton) {
            historyToggleButton.addEventListener('click', () => {
                HistoryManager.toggleHistorySection();
            });
        }

        if (clearHistoryButton) {
            clearHistoryButton.addEventListener('click', () => {
                HistoryManager.clearAllHistory();
            });
        }
        
        // Ajustes de ventana
        window.addEventListener('resize', function() {
            if (scanning) {
                adjustScannerLayout();
            }
        });
        
        window.addEventListener('orientationchange', function() {
            if (scanning) {
                setTimeout(adjustScannerLayout, 500);
            }
        });
        
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && scanning) {
                // Si el modal de confirmación está abierto, solo ciérralo
                if (PalletManager.elements.scanConfirmationModal && PalletManager.elements.scanConfirmationModal.classList.contains('show')) {
                    PalletManager.closeModal(PalletManager.elements.scanConfirmationModal);
                    if (scanning) Quagga.start(); // Reanudar escáner
                } else { // Si no está abierto el modal de confirmación, detén el escáner
                    stopScanner();
                }
            }
        });
        
        document.addEventListener('visibilitychange', function() {
            if (document.hidden && scanning) {
                stopScanner();
            }
        });

        // Guardar automáticamente antes de cerrar la página
        window.addEventListener('beforeunload', function() {
            if (scannedPalletsSessionData.length > 0) {
                PersistenceManager.saveSessionData(scannedPalletsSessionData);
            }
        });
        
        Logger.log('Event listeners principales adjuntados');
    }

    // Función principal de inicialización
    function initializeApp() {
        try {
            Logger.log('Iniciando aplicación de inventario v2.1.0');
            
            // Inicializar utilidades
            initializeUtilities();
            
            // Verificar disponibilidad de localStorage
            if (!PersistenceManager.isAvailable()) {
                displayResult('Advertencia: El almacenamiento local no está disponible. Los datos no se guardarán automáticamente.', true);
            }
            
            // Inicializar PalletManager
            PalletManager.init();
            
            // Adjuntar event listeners principales
            attachMainEventListeners();
            
            // Verificar sesión anterior
            checkForPreviousSession();
            
            // Exponer PalletManager globalmente para funciones onclick del HTML
            window.PalletManager = PalletManager;
            
            Logger.log("Aplicación inicializada correctamente con persistencia y modo edición");
            
        } catch (error) {
            Logger.error('Error crítico al inicializar la aplicación', error);
            displayResult('Error al inicializar la aplicación. Por favor, recargue la página.', true);
        }
    }

    // Verificar si todos los elementos DOM están disponibles
    function checkDOMElements() {
        const requiredElements = [
            'startScanButton', 'stopScanButton', 'scannerContainer', 'scannerVideo',
            'manualPalletIdInput', 'checkManualButton', 'resultDisplay', 
            'palletSummary', 'loadingIndicator', 'sessionScannedList',
            'finishSessionButton', 'sessionResultDisplay', // Existing elements
            'addPalletModal', 'editPalletModal', 'confirmationModal', 'sessionDetailModal', // Existing modals
            // NUEVOS ELEMENTOS DEL MODAL DE CONFIRMACIÓN DE ESCANEO
            'scanConfirmationModal', 'scannedCodeDisplay', 'rescanButton', 'confirmScanButton'
        ];
        
        const missingElements = requiredElements.filter(id => !document.getElementById(id));
        
        if (missingElements.length > 0) {
            Logger.error('Elementos DOM faltantes', missingElements);
            return false;
        }
        
        return true;
    }

    // Función de inicio con verificación de DOM
    function startApp() {
        if (checkDOMElements()) {
            initializeApp();
        } else {
            Logger.error('No se pueden encontrar todos los elementos DOM necesarios. Reintentando...');
            setTimeout(startApp, 200); // Reintentar después de 200ms
        }
    }

    // Inicializar cuando el DOM esté listo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startApp);
    } else {
        startApp();
    }

    // Manejo de errores globales
    window.addEventListener('error', function(event) {
        Logger.error('Error global capturado', {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno
        });
    });

    window.addEventListener('unhandledrejection', function(event) {
        Logger.error('Promise rechazada no manejada', event.reason);
    });

});