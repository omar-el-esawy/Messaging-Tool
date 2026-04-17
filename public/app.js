// API Base URL — detect base path from current page location
const BASE = window.location.pathname.replace(/\/+$/, '');
const API_BASE = `${BASE}/api`;

// DOM Elements
const qrSection = document.getElementById('qrSection');
const messagingSection = document.getElementById('messagingSection');
const qrCodeContainer = document.getElementById('qrCodeContainer');
const statusIndicator = document.getElementById('statusIndicator');
const logoutBtn = document.getElementById('logoutBtn');
const messageForm = document.getElementById('messageForm');
const imageForm = document.getElementById('imageForm');
const checkForm = document.getElementById('checkForm');
const messageText = document.getElementById('messageText');
const charCount = document.getElementById('charCount');
const checkResult = document.getElementById('checkResult');

// State
let isAuthenticated = false;
let statusCheckInterval = null;
let qrCheckInterval = null;
let hasConnectionError = false;

// Escape HTML to prevent XSS
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    setupEventListeners();
});

// Initialize application
async function initializeApp() {
    console.log('Initializing application...');
    await checkStatus();
    startStatusPolling();
}

// Setup event listeners
function setupEventListeners() {
    // Character counter
    messageText.addEventListener('input', (e) => {
        charCount.textContent = e.target.value.length;
    });

    // Message form
    messageForm.addEventListener('submit', handleSendMessage);

    // Image form
    imageForm.addEventListener('submit', handleSendImage);

    // Check form
    checkForm.addEventListener('submit', handleCheckNumber);

    // Logout button
    logoutBtn.addEventListener('click', handleLogout);
}

// Check connection status
async function checkStatus() {
    try {
        const response = await fetch(`${API_BASE}/status`);
        if (response.status === 401) {
            window.location.href = `${BASE}/login.html`;
            return;
        }
        const data = await response.json();
        hasConnectionError = false;

        updateStatus(data);

        if (data.authenticated) {
            showMessagingSection();
        } else if (data.hasQR) {
            await fetchQRCode();
        } else {
            startQRPolling();
        }
    } catch (error) {
        console.error('Error checking status:', error);
        updateStatusIndicator('disconnected', 'Connection Error');
        if (!hasConnectionError) {
            hasConnectionError = true;
            showToast('error', 'Connection Error', 'Unable to connect to server');
        }
    }
}

// Update status based on server response
function updateStatus(data) {
    isAuthenticated = data.authenticated;

    let statusText = 'Connecting...';
    let statusClass = 'connecting';

    if (data.authenticated) {
        statusText = 'Connected';
        statusClass = 'connected';
    } else if (data.status === 'qr_ready') {
        statusText = 'Scan QR Code';
        statusClass = 'connecting';
    } else if (data.status === 'disconnected') {
        statusText = 'Disconnected';
        statusClass = 'disconnected';
    }

    updateStatusIndicator(statusClass, statusText);
}

// Update status indicator UI
function updateStatusIndicator(statusClass, statusText) {
    statusIndicator.className = `status-indicator ${statusClass}`;
    statusIndicator.querySelector('.status-text').textContent = statusText;
}

// Fetch QR code from server
async function fetchQRCode() {
    try {
        const response = await fetch(`${API_BASE}/qr`);
        const data = await response.json();

        if (data.success && data.qrCode) {
            displayQRCode(data.qrCode);
            stopQRPolling();
        } else if (data.authenticated) {
            showMessagingSection();
            stopQRPolling();
        }
    } catch (error) {
        console.error('Error fetching QR code:', error);
    }
}

// Display QR code
function displayQRCode(qrCodeData) {
    qrCodeContainer.innerHTML = `<img src="${qrCodeData}" alt="QR Code" />`;
}

// Show messaging section
function showMessagingSection() {
    if (messagingSection.style.display === 'block') return;
    qrSection.style.display = 'none';
    messagingSection.style.display = 'block';
    logoutBtn.style.display = 'flex';
    isAuthenticated = true;
    stopQRPolling();
    showToast('success', 'Connected!', 'WhatsApp authenticated successfully');
}

// Show QR section
function showQRSection() {
    qrSection.style.display = 'flex';
    messagingSection.style.display = 'none';
    logoutBtn.style.display = 'none';
    isAuthenticated = false;
    qrCodeContainer.innerHTML = `
        <div class="qr-loader">
            <div class="spinner"></div>
            <p>Generating QR Code...</p>
        </div>
    `;
    startQRPolling();
}

// Start polling for status updates
function startStatusPolling() {
    if (statusCheckInterval) return;

    statusCheckInterval = setInterval(async () => {
        await checkStatus();
    }, 3000);
}

// Stop status polling
function stopStatusPolling() {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
    }
}

// Start polling for QR code
function startQRPolling() {
    if (qrCheckInterval) return;

    qrCheckInterval = setInterval(async () => {
        if (!isAuthenticated) {
            await fetchQRCode();
        } else {
            stopQRPolling();
        }
    }, 2000);
}

// Stop QR polling
function stopQRPolling() {
    if (qrCheckInterval) {
        clearInterval(qrCheckInterval);
        qrCheckInterval = null;
    }
}

// Handle send message
async function handleSendMessage(e) {
    e.preventDefault();

    const phoneNumber = document.getElementById('phoneNumber').value;
    const message = document.getElementById('messageText').value;
    const sendBtn = document.getElementById('sendBtn');

    if (!phoneNumber || !message) {
        showToast('error', 'Validation Error', 'Please fill in all fields');
        return;
    }

    setButtonLoading(sendBtn, true);

    try {
        const response = await fetch(`${API_BASE}/send-message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                number: phoneNumber,
                message: message
            })
        });

        const data = await response.json();

        if (data.success) {
            showToast('success', 'Message Sent!', `Message sent to ${phoneNumber}`);
            messageForm.reset();
            charCount.textContent = '0';
        } else {
            showToast('error', 'Send Failed', data.error || 'Failed to send message');
        }
    } catch (error) {
        console.error('Error sending message:', error);
        showToast('error', 'Error', 'Failed to send message. Please try again.');
    } finally {
        setButtonLoading(sendBtn, false);
    }
}

// Handle send image
async function handleSendImage(e) {
    e.preventDefault();

    const phoneNumber = document.getElementById('imagePhoneNumber').value;
    const imageUrl = document.getElementById('imageUrl').value;
    const caption = document.getElementById('imageCaption').value;
    const sendBtn = document.getElementById('sendImageBtn');

    if (!phoneNumber || !imageUrl) {
        showToast('error', 'Validation Error', 'Please fill in all required fields');
        return;
    }

    setButtonLoading(sendBtn, true);

    try {
        const response = await fetch(`${API_BASE}/send-image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                number: phoneNumber,
                imageUrl: imageUrl,
                caption: caption
            })
        });

        const data = await response.json();

        if (data.success) {
            showToast('success', 'Image Sent!', `Image sent to ${phoneNumber}`);
            imageForm.reset();
        } else {
            showToast('error', 'Send Failed', data.error || 'Failed to send image');
        }
    } catch (error) {
        console.error('Error sending image:', error);
        showToast('error', 'Error', 'Failed to send image. Please try again.');
    } finally {
        setButtonLoading(sendBtn, false);
    }
}

// Handle check number
async function handleCheckNumber(e) {
    e.preventDefault();

    const phoneNumber = document.getElementById('checkPhoneNumber').value;
    const checkBtn = document.getElementById('checkBtn');

    if (!phoneNumber) {
        showToast('error', 'Validation Error', 'Please enter a phone number');
        return;
    }

    setButtonLoading(checkBtn, true);
    checkResult.classList.remove('show', 'success', 'error');

    try {
        const response = await fetch(`${API_BASE}/check-number`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                number: phoneNumber
            })
        });

        const data = await response.json();

        if (data.success) {
            const result = data.data;
            const isValid = result.numberExists;

            checkResult.className = `check-result show ${isValid ? 'success' : 'error'}`;
            checkResult.innerHTML = `
                <h4>${isValid ? '✓ Valid WhatsApp Number' : '✗ Invalid Number'}</h4>
                <p><strong>Number:</strong> ${escapeHtml(result.id?.user || phoneNumber)}</p>
                <p><strong>Status:</strong> ${result.numberExists ? 'Registered on WhatsApp' : 'Not registered'}</p>
            `;

            showToast(
                isValid ? 'success' : 'error',
                isValid ? 'Valid Number' : 'Invalid Number',
                isValid ? 'This number is registered on WhatsApp' : 'This number is not on WhatsApp'
            );
        } else {
            checkResult.className = 'check-result show error';
            checkResult.innerHTML = `
                <h4>✗ Check Failed</h4>
                <p>${escapeHtml(data.error || 'Unable to verify number')}</p>
            `;
            showToast('error', 'Check Failed', data.error || 'Unable to verify number');
        }
    } catch (error) {
        console.error('Error checking number:', error);
        checkResult.className = 'check-result show error';
        checkResult.innerHTML = `
            <h4>✗ Error</h4>
            <p>Failed to check number. Please try again.</p>
        `;
        showToast('error', 'Error', 'Failed to check number. Please try again.');
    } finally {
        setButtonLoading(checkBtn, false);
    }
}

// Handle logout
async function handleLogout() {
    if (!confirm('Are you sure you want to logout?')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/logout`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            window.location.href = `${BASE}/login.html`;
        }
    } catch (error) {
        console.error('Error logging out:', error);
        showToast('error', 'Error', 'Failed to logout. Please try again.');
    }
}

// Set button loading state
function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.disabled = true;
        button.classList.add('loading');
    } else {
        button.disabled = false;
        button.classList.remove('loading');
    }
}

// Show toast notification
function showToast(type, title, message) {
    const toastContainer = document.getElementById('toastContainer');

    const icons = {
        success: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>`,
        error: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>`,
        info: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>`
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        ${icons[type] || ''}
        <div class="toast-content">
            <div class="toast-title">${escapeHtml(title)}</div>
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
    `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s ease-out reverse';
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 4000);
}

// Handle page visibility change
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopStatusPolling();
        stopQRPolling();
    } else {
        checkStatus();
        startStatusPolling();
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopStatusPolling();
    stopQRPolling();
});
