const BASE = window.location.pathname.replace(/\/login\.html$/, '').replace(/\/+$/, '');
const API_BASE = `${BASE}/api`;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(type, title, message) {
    const toastContainer = document.getElementById('toastContainer');
    const icons = {
        error: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>`,
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
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function setButtonLoading(button, isLoading) {
    button.disabled = isLoading;
    button.classList.toggle('loading', isLoading);
}

// Redirect to main app if already authenticated
async function checkExistingSession() {
    try {
        const res = await fetch(`${API_BASE}/auth-status`);
        const data = await res.json();
        if (data.authenticated) {
            window.location.href = BASE || '/';
        }
    } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
    checkExistingSession();

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const loginBtn = document.getElementById('loginBtn');

        if (!username || !password) {
            showToast('error', 'Validation Error', 'Please fill in all fields');
            return;
        }

        setButtonLoading(loginBtn, true);

        try {
            const res = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();

            if (data.success) {
                window.location.href = BASE || '/';
            } else {
                showToast('error', 'Login Failed', data.error || 'Invalid credentials');
            }
        } catch {
            showToast('error', 'Error', 'Unable to connect to server');
        } finally {
            setButtonLoading(loginBtn, false);
        }
    });
});
