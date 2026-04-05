const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// State management
let numbers = [];
let templates = ['Halo, ini pesan blast dari CyberBlast!'];
let currentBlast = null;
let stats = { sent: 0, failed: 0, pending: 0, active: 0 };
let monitorLogs = [];

// DOM Elements
const pages = document.querySelectorAll('.page');
const bottomNavItems = document.querySelectorAll('.bottom-nav-item');
const navItems = document.querySelectorAll('.nav-item');
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');

// Socket connection handlers
socket.on('connect', () => {
    addMonitorLog('System', 'active', 'Terhubung ke server');
});

socket.on('disconnect', () => {
    addMonitorLog('System', 'inactive', 'Terputus dari server, mencoba reconnect...');
});

socket.on('connect_error', (error) => {
    addMonitorLog('System', 'failed', `Koneksi error: ${error.message}`);
});

// Load saved data from localStorage
function loadData() {
    try {
        const savedNumbers = localStorage.getItem('whatsapp_numbers');
        const savedTemplates = localStorage.getItem('whatsapp_templates');
        
        if (savedNumbers) {
            numbers = JSON.parse(savedNumbers);
            renderNumbersList();
            renderSenderSelect();
        }
        
        if (savedTemplates) {
            templates = JSON.parse(savedTemplates);
            renderTemplates();
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// Save data
function saveNumbers() {
    localStorage.setItem('whatsapp_numbers', JSON.stringify(numbers));
    renderNumbersList();
    renderSenderSelect();
}

function saveTemplates() {
    localStorage.setItem('whatsapp_templates', JSON.stringify(templates));
}

// Render templates
function renderTemplates() {
    const container = document.getElementById('templatesContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    templates.forEach((template, index) => {
        const div = document.createElement('div');
        div.className = 'template-item';
        div.innerHTML = `
            <textarea class="template-text" rows="2" placeholder="Template ${index + 1}">${escapeHtml(template)}</textarea>
            <button class="btn-icon remove-template" data-index="${index}"><i class="fas fa-trash"></i></button>
        `;
        container.appendChild(div);
    });
    
    // Add event listeners
    document.querySelectorAll('.template-text').forEach((textarea, idx) => {
        textarea.addEventListener('change', (e) => {
            templates[idx] = e.target.value;
            saveTemplates();
        });
    });
    
    document.querySelectorAll('.remove-template').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(btn.dataset.index);
            templates.splice(index, 1);
            if (templates.length === 0) templates = ['Halo, ini pesan blast dari CyberBlast!'];
            saveTemplates();
            renderTemplates();
        });
    });
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Render numbers list
function renderNumbersList() {
    const container = document.getElementById('numbersList');
    const connectedContainer = document.getElementById('connectedNumbersList');
    
    if (!container) return;
    
    if (numbers.length === 0) {
        container.innerHTML = '<div class="empty-state">Belum ada nomor. Tambahkan nomor baru!</div>';
        if (connectedContainer) connectedContainer.innerHTML = '<div class="empty-state">Belum ada nomor terhubung</div>';
        return;
    }
    
    container.innerHTML = numbers.map(number => `
        <div class="number-card" data-number="${number}">
            <div class="number-info">
                <i class="fas fa-phone-alt"></i>
                <span class="number-value">${escapeHtml(number)}</span>
                <span class="status-badge ${getNumberStatus(number)}" id="status-${number}">
                    ${getNumberStatusText(number)}
                </span>
            </div>
            <div class="number-actions">
                <button class="check-status" data-number="${number}"><i class="fas fa-sync-alt"></i></button>
                <button class="remove-number" data-number="${number}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
    
    // Update connected numbers list for pairing page
    if (connectedContainer) {
        const connectedNumbers = numbers.filter(n => getNumberStatus(n) === 'active');
        if (connectedNumbers.length === 0) {
            connectedContainer.innerHTML = '<div class="empty-state">Belum ada nomor terhubung</div>';
        } else {
            connectedContainer.innerHTML = connectedNumbers.map(number => `
                <div class="number-card">
                    <div class="number-info">
                        <i class="fas fa-check-circle" style="color: var(--success)"></i>
                        <span>${escapeHtml(number)}</span>
                        <span class="status-badge active">Active</span>
                    </div>
                </div>
            `).join('');
        }
    }
    
    // Add event listeners
    document.querySelectorAll('.check-status').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const number = btn.dataset.number;
            checkNumberStatus(number);
        });
    });
    
    document.querySelectorAll('.remove-number').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const number = btn.dataset.number;
            numbers = numbers.filter(n => n !== number);
            saveNumbers();
            renderNumbersList();
        });
    });
}

// Render sender select
function renderSenderSelect() {
    const select = document.getElementById('senderNumber');
    if (!select) return;
    
    const activeNumbers = numbers.filter(n => getNumberStatus(n) === 'active');
    select.innerHTML = '<option value="">Pilih nomor...</option>' + 
        activeNumbers.map(number => `<option value="${escapeHtml(number)}">${escapeHtml(number)}</option>`).join('');
}

// Get number status from localStorage
function getNumberStatus(number) {
    const status = localStorage.getItem(`status_${number}`);
    return status || 'inactive';
}

function getNumberStatusText(number) {
    const status = getNumberStatus(number);
    const texts = {
        active: 'Active',
        banned: 'Banned',
        limited: 'Batasi',
        inactive: 'Tidak Active'
    };
    return texts[status] || 'Tidak Active';
}

// Check number status
function checkNumberStatus(number) {
    socket.emit('get_status', { phoneNumber: number });
    
    socket.once('status_response', (data) => {
        if (data.phoneNumber === number) {
            localStorage.setItem(`status_${number}`, data.status);
            renderNumbersList();
            renderSenderSelect();
            addMonitorLog(number, data.status, `Status: ${data.status}`);
            updateStats();
        }
    });
}

// Add monitor log
function addMonitorLog(number, status, message) {
    const logContainer = document.getElementById('monitorLog');
    if (!logContainer) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${status}`;
    logEntry.innerHTML = `
        <strong>${new Date().toLocaleTimeString()}</strong> - 
        <strong>${escapeHtml(number)}:</strong> ${escapeHtml(message)}
    `;
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
    
    // Limit logs to 100 entries
    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
    
    // Update stats
    if (status === 'sent') stats.sent++;
    else if (status === 'failed') stats.failed++;
    else if (status === 'pending') stats.pending++;
    else if (status === 'active') stats.active++;
    
    updateStatsDisplay();
}

function updateStatsDisplay() {
    const sentEl = document.getElementById('statSent');
    const failedEl = document.getElementById('statFailed');
    const pendingEl = document.getElementById('statPending');
    const activeEl = document.getElementById('statActive');
    
    if (sentEl) sentEl.textContent = stats.sent;
    if (failedEl) failedEl.textContent = stats.failed;
    if (pendingEl) pendingEl.textContent = stats.pending;
    if (activeEl) activeEl.textContent = numbers.filter(n => getNumberStatus(n) === 'active').length;
}

function updateStats() {
    stats.active = numbers.filter(n => getNumberStatus(n) === 'active').length;
    updateStatsDisplay();
}

// Socket event handlers
socket.on('qr', (data) => {
    addMonitorLog(data.phoneNumber, 'pending', 'QR Code received (fallback method)');
});

socket.on('pairing_code', (data) => {
    const resultDiv = document.getElementById('pairingResult');
    const codeDisplay = document.getElementById('pairingCodeDisplay');
    if (resultDiv && codeDisplay) {
        codeDisplay.textContent = `Pairing Code: ${data.code}`;
        resultDiv.style.display = 'block';
        addMonitorLog(data.phoneNumber, 'pending', `Pairing code: ${data.code}`);
        
        // Auto hide after 5 minutes
        setTimeout(() => {
            resultDiv.style.display = 'none';
        }, 300000);
    }
});

socket.on('status_update', (data) => {
    localStorage.setItem(`status_${data.phoneNumber}`, data.status);
    renderNumbersList();
    renderSenderSelect();
    addMonitorLog(data.phoneNumber, data.status, data.message);
    updateStats();
});

socket.on('blast_progress', (data) => {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    if (progressFill && progressText) {
        const percent = (data.current / data.total) * 100;
        progressFill.style.width = `${percent}%`;
        progressFill.textContent = `${Math.round(percent)}%`;
        progressText.textContent = `Mengirim ${data.current}/${data.total}...`;
    }
    
    if (data.lastResult) {
        addMonitorLog(data.lastResult.number, data.lastResult.status, 
            data.lastResult.status === 'sent' ? 'Pesan terkirim' : 'Pesan gagal');
    }
});

socket.on('blast_result', (data) => {
    const progressDiv = document.getElementById('blastProgress');
    const progressFill = document.getElementById('progressFill');
    
    if (progressDiv) progressDiv.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    
    const sent = data.results.filter(r => r.status === 'sent').length;
    const failed = data.results.filter(r => r.status === 'failed').length;
    const pending = data.results.filter(r => r.status === 'pending').length;
    
    addMonitorLog(data.phoneNumber, 'sent', `Blast selesai! Terkirim: ${sent}, Gagal: ${failed}, Pending: ${pending}`);
    
    alert(`Blast selesai!\nTerkirim: ${sent}\nGagal: ${failed}\nPending: ${pending}`);
});

socket.on('error', (data) => {
    addMonitorLog(data.phoneNumber || 'System', 'failed', data.error);
});

// Request pairing
document.getElementById('requestPairingBtn')?.addEventListener('click', () => {
    const phoneNumber = document.getElementById('pairingPhone').value;
    if (!phoneNumber) {
        alert('Masukkan nomor telepon!');
        return;
    }
    
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    // Add to numbers if not exists
    if (!numbers.includes(cleanNumber)) {
        numbers.push(cleanNumber);
        saveNumbers();
    }
    
    socket.emit('request_pairing', { phoneNumber: cleanNumber });
    addMonitorLog(cleanNumber, 'pending', 'Meminta pairing code...');
});

// Send blast
document.getElementById('sendBlastBtn')?.addEventListener('click', async () => {
    const senderNumber = document.getElementById('senderNumber').value;
    const targetNumbersRaw = document.getElementById('targetNumbers').value;
    const delay = parseInt(document.getElementById('delayValue').value);
    
    if (!senderNumber) {
        alert('Pilih nomor pengirim!');
        return;
    }
    
    if (!targetNumbersRaw) {
        alert('Masukkan target nomor!');
        return;
    }
    
    // Parse targets
    let targets = targetNumbersRaw.split(/[,\n]/).map(t => t.trim()).filter(t => t);
    
    if (targets.length === 0) {
        alert('Masukkan minimal 1 target nomor!');
        return;
    }
    
    // Get templates from textareas
    const templateTextareas = document.querySelectorAll('.template-text');
    const blastTemplates = Array.from(templateTextareas).map(ta => ta.value);
    
    if (blastTemplates.length === 0 || blastTemplates[0].trim() === '') {
        alert('Masukkan template pesan!');
        return;
    }
    
    const progressDiv = document.getElementById('blastProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    if (progressDiv) progressDiv.style.display = 'block';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = 'Memulai blast...';
    
    socket.emit('send_blast', {
        phoneNumber: senderNumber,
        targets: targets,
        templates: blastTemplates,
        delay: delay
    });
});

// Add new number
document.getElementById('addNumberBtn')?.addEventListener('click', () => {
    const newNumber = document.getElementById('newNumber').value;
    if (!newNumber) {
        alert('Masukkan nomor telepon!');
        return;
    }
    
    const cleanNumber = newNumber.replace(/[^0-9]/g, '');
    
    if (!numbers.includes(cleanNumber)) {
        numbers.push(cleanNumber);
        saveNumbers();
        document.getElementById('newNumber').value = '';
        addMonitorLog(cleanNumber, 'inactive', 'Nomor ditambahkan');
    } else {
        alert('Nomor sudah ada!');
    }
});

// Navigation
function navigateTo(pageName) {
    pages.forEach(page => page.classList.remove('active'));
    const targetPage = document.getElementById(`${pageName}Page`);
    if (targetPage) targetPage.classList.add('active');
    
    // Update active states
    bottomNavItems.forEach(item => {
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    navItems.forEach(item => {
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // Close sidebar on mobile
    if (window.innerWidth < 768) {
        sidebar.classList.remove('open');
    }
}

bottomNavItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        navigateTo(page);
    });
});

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        navigateTo(page);
    });
});

menuToggle?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
});

// Close sidebar when clicking outside
document.addEventListener('click', (e) => {
    if (window.innerWidth < 768 && sidebar.classList.contains('open')) {
        if (!sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
            sidebar.classList.remove('open');
        }
    }
});

// Initial load
loadData();
updateStats();

// Periodic status check
setInterval(() => {
    numbers.forEach(number => {
        checkNumberStatus(number);
    });
}, 60000); // Check every minute
