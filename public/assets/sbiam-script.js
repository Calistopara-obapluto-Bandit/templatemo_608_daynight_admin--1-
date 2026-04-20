/* ========================================
   God's Time Logde - JavaScript
   ======================================== */

// Role and access control are enforced by the backend.

// ===== Theme Toggle =====
function initTheme() {
    const savedTheme = localStorage.getItem('gods-time-logde-theme');
    if (savedTheme === 'carbon') {
        document.documentElement.classList.add('carbon');
        document.body.classList.add('carbon');
        updateThemeButtons('carbon');
    } else {
        updateThemeButtons('snow');
    }
}

function setTheme(theme) {
    if (theme === 'carbon') {
        document.documentElement.classList.add('carbon');
        document.body.classList.add('carbon');
        localStorage.setItem('gods-time-logde-theme', 'carbon');
    } else {
        document.documentElement.classList.remove('carbon');
        document.body.classList.remove('carbon');
        localStorage.setItem('gods-time-logde-theme', 'snow');
    }
    updateThemeButtons(theme);
}

function updateThemeButtons(theme) {
    const snowBtns = document.querySelectorAll('.theme-btn-snow');
    const carbonBtns = document.querySelectorAll('.theme-btn-carbon');
    
    snowBtns.forEach(btn => {
        btn.classList.toggle('active', theme === 'snow');
    });
    carbonBtns.forEach(btn => {
        btn.classList.toggle('active', theme === 'carbon');
    });
}

// ===== Time-based Greeting =====
function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function setGreeting() {
    const greetingEl = document.getElementById('greeting');
    if (greetingEl) {
        const name = greetingEl.getAttribute('data-name') || 'Admin';
        greetingEl.textContent = getGreeting() + ', ' + name;
    }
}

// ===== Date Range Picker =====
function setDateRange(range, btn) {
    const btns = document.querySelectorAll('.date-btn');
    btns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Update charts based on range
    updateCharts(range);
}

function updateCharts(range) {
    // Animate chart bars based on selected range
    const bars = document.querySelectorAll('.bar');
    bars.forEach(bar => {
        const currentHeight = parseInt(bar.style.height);
        let multiplier = 1;
        
        if (range === '7d') multiplier = 0.7;
        if (range === '30d') multiplier = 1;
        if (range === '90d') multiplier = 1.2;
        if (range === '12m') multiplier = 1.4;
        
        // Random variation
        const variation = 0.8 + Math.random() * 0.4;
        bar.style.height = (currentHeight * multiplier * variation) + 'px';
    });
}

// ===== Inbox =====
function selectMessage(el, index) {
    // Remove active from all
    document.querySelectorAll('.message-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Add active to selected
    el.classList.add('active');
    el.classList.remove('unread');
    
    // Update message view
    updateMessageView(index);
}

function updateMessageView(index) {
    const messages = [
        {
            subject: 'Project Update: Q1 Dashboard Redesign',
            sender: 'Sarah Chen',
            email: 'sarah.chen@company.com',
            date: 'Jan 2, 2026 at 9:45 AM',
            body: `<p>Hi Alex,</p>
                   <p>I wanted to give you a quick update on the Q1 dashboard redesign project. We've completed the wireframes and initial mockups, and the team is ready to move into the development phase.</p>
                   <p>Key highlights from our progress:</p>
                   <p>• User research completed with 15 participants<br>
                   • 3 design concepts presented to stakeholders<br>
                   • Final direction approved by leadership<br>
                   • Development sprint starting next Monday</p>
                   <p>Could we schedule a quick sync tomorrow to go over the technical requirements? Let me know what time works best for you.</p>
                   <p>Best regards,<br>Sarah</p>`
        },
        {
            subject: 'Weekly Analytics Report',
            sender: 'Analytics Bot',
            email: 'analytics@company.com',
            date: 'Jan 1, 2026 at 8:00 AM',
            body: `<p>Hello Alex,</p>
                   <p>Here's your weekly analytics summary for December 25-31, 2025:</p>
                   <p><strong>Traffic Overview:</strong><br>
                   Total visitors: 45,230 (+12% vs last week)<br>
                   Page views: 128,450 (+8%)<br>
                   Avg. session duration: 4m 32s</p>
                   <p><strong>Top Performing Pages:</strong><br>
                   1. /dashboard - 15,230 views<br>
                   2. /analytics - 8,450 views<br>
                   3. /projects - 6,780 views</p>
                   <p>View the full report in your Analytics dashboard.</p>`
        },
        {
            subject: 'New Team Member Introduction',
            sender: 'HR Team',
            email: 'hr@company.com',
            date: 'Dec 31, 2025 at 2:30 PM',
            body: `<p>Dear Team,</p>
                   <p>We're excited to announce that Michael Torres will be joining our engineering team starting January 6th as a Senior Frontend Developer.</p>
                   <p>Michael comes to us with 8 years of experience in web development and has previously worked at several notable tech companies. He'll be working closely with the product team on our new features.</p>
                   <p>Please join us in welcoming Michael to the team!</p>
                   <p>Best,<br>HR Team</p>`
        }
    ];
    
    const msg = messages[index] || messages[0];
    
    document.querySelector('.message-view-subject').textContent = msg.subject;
    document.querySelector('.message-view-sender-name').textContent = msg.sender;
    document.querySelector('.message-view-sender-email').textContent = msg.email;
    document.querySelector('.message-view-date').textContent = msg.date;
    document.querySelector('.message-view-body').innerHTML = msg.body;
}

// ===== Kanban =====
function initKanban() {
    const cards = document.querySelectorAll('.kanban-card');
    const columns = document.querySelectorAll('.kanban-cards');
    
    cards.forEach(card => {
        card.setAttribute('draggable', true);
        
        card.addEventListener('dragstart', (e) => {
            card.classList.add('dragging');
        });
        
        card.addEventListener('dragend', (e) => {
            card.classList.remove('dragging');
        });
    });
    
    columns.forEach(column => {
        column.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.dragging');
            column.appendChild(dragging);
        });
    });
}

// ===== Settings Toggles =====
function initToggles() {
    const toggles = document.querySelectorAll('.toggle input');
    toggles.forEach(toggle => {
        toggle.addEventListener('change', function() {
            console.log(`${this.id} is now ${this.checked ? 'enabled' : 'disabled'}`);
        });
    });
}

// ===== Mobile Menu =====
function toggleMobileMenu() {
    const menu = document.querySelector('.mobile-menu');
    const overlay = document.querySelector('.mobile-menu-overlay');
    
    if (menu && overlay) {
        menu.classList.toggle('active');
        overlay.classList.toggle('active');
        document.body.style.overflow = menu.classList.contains('active') ? 'hidden' : '';
    }
}

function closeMobileMenu() {
    const menu = document.querySelector('.mobile-menu');
    const overlay = document.querySelector('.mobile-menu-overlay');
    
    if (menu && overlay) {
        menu.classList.remove('active');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function normalizeTenantEmail(fullName) {
    const base = String(fullName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return `${base || 'tenant'}.tn@gtlodge.com`;
}

function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function initTenantEmailForms() {
    const forms = document.querySelectorAll('[data-tenant-email-form]');
    if (!forms.length) return;

    forms.forEach((form) => {
        const nameInput = form.querySelector('[data-invite-full-name], [data-tenant-email-full-name]');
        const codeInput = form.querySelector('[data-invite-code]');
        const statusEl = form.querySelector('[data-invite-status]');
        const previewEl = form.querySelector('[data-tenant-email-preview]');
        const submitBtn = form.querySelector('[data-invite-submit]');
        let requestId = 0;

        const updatePreview = () => {
            if (!previewEl) return;
            const fullName = (nameInput?.value || '').trim();
            if (!fullName) {
                previewEl.textContent = 'Your lodge email will be generated from your name.';
                return;
            }

            if (looksLikeEmail(fullName)) {
                previewEl.textContent = 'Enter your full name here. Your lodge email will be generated automatically.';
                return;
            }

            previewEl.textContent = `Generated email: ${normalizeTenantEmail(fullName)}`;
        };

        const setStatus = (state, message) => {
            if (!statusEl) return;
            statusEl.textContent = message;
            statusEl.className = 'invite-status' + (state ? ` ${state}` : '');
            if (submitBtn) {
                submitBtn.disabled = state === 'checking';
            }
        };

        const validateInvite = async () => {
            const fullName = (nameInput?.value || '').trim();
            const inviteCode = (codeInput?.value || '').trim().toUpperCase();

            updatePreview();

            if (!fullName || !inviteCode) {
                if (statusEl) {
                    setStatus('', 'Enter your approved full name and invite code to verify access.');
                }
                return;
            }

            if (!statusEl) return;

            const currentRequest = ++requestId;
            setStatus('checking', 'Checking your invitation...');

            try {
                const params = new URLSearchParams({ full_name: fullName, invite_code: inviteCode });
                const response = await fetch(`/register/invite-status?${params.toString()}`, {
                    headers: { 'Accept': 'application/json' }
                });
                if (!response.ok) {
                    throw new Error('Request failed');
                }
                const result = await response.json();
                if (currentRequest !== requestId) return;
                setStatus(result.ok ? 'valid' : result.state || 'invalid', result.message || 'Invite status unavailable.');
            } catch (error) {
                if (currentRequest !== requestId) return;
                setStatus('invalid', 'Could not verify the invite right now. You can still try again in a moment.');
            }
        };

        let timer = null;
        const queueValidation = () => {
            clearTimeout(timer);
            timer = setTimeout(validateInvite, 250);
        };

        nameInput?.addEventListener('input', queueValidation);
        codeInput?.addEventListener('input', () => {
            codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
            queueValidation();
        });
        nameInput?.addEventListener('blur', validateInvite);
        codeInput?.addEventListener('blur', validateInvite);

        updatePreview();
        if (!statusEl) {
            queueValidation();
        }
    });
}

function initRealtimeNotifications() {
    const liveReminders = document.querySelector('[data-live-reminders]');
    const path = window.location.pathname || '';
    const isDashboard = path === '/tenant/dashboard' || path === '/admin/dashboard';
    if (!isDashboard || !liveReminders || typeof EventSource === 'undefined') return;

    let currentVersion = null;
    let isReady = false;
    let toastStack = null;

    const ensureToastStack = () => {
        if (toastStack) return toastStack;
        toastStack = document.createElement('div');
        toastStack.className = 'live-toast-stack';
        document.body.appendChild(toastStack);
        return toastStack;
    };

    const showToast = (message, tone = 'accent') => {
        const stack = ensureToastStack();
        const toast = document.createElement('div');
        toast.className = `live-toast ${tone}`;
        toast.textContent = message;
        stack.appendChild(toast);
        window.setTimeout(() => {
            toast.classList.add('leaving');
            window.setTimeout(() => toast.remove(), 250);
        }, 3200);
    };

    const refreshNotifications = async (showVisualCue) => {
        try {
            const response = await fetch('/api/notifications', {
                headers: { 'Accept': 'application/json' },
                cache: 'no-store'
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (!payload || !payload.html) return;

            const target = document.querySelector('[data-live-reminders]');
            if (target) {
                target.outerHTML = payload.html;
            }

            if (showVisualCue && payload.items && payload.items.length) {
                showToast(payload.items[0].title, payload.items[0].tone || 'accent');
            } else if (showVisualCue) {
                showToast('Notifications updated.', 'success');
            }

            currentVersion = payload.version;
            isReady = true;
        } catch (error) {
            // Keep the dashboard usable even if the live stream fails.
        }
    };

    refreshNotifications(false);

    const stream = new EventSource('/api/notifications/stream');
    stream.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data || '{}');
            if (currentVersion === null) {
                currentVersion = payload.version;
                return;
            }
            if (payload.version !== currentVersion) {
                refreshNotifications(isReady);
            }
        } catch (error) {
            // Ignore malformed events and keep the stream alive.
        }
    };

    stream.onerror = () => {
        // EventSource reconnects on its own; no extra work needed here.
    };
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', function() {
    initTheme();
    setGreeting();
    initTenantEmailForms();
    initRealtimeNotifications();
    
    if (document.querySelector('.kanban-board')) {
        initKanban();
    }
    
    if (document.querySelector('.toggle')) {
        initToggles();
    }
    
    // Close mobile menu on overlay click
    const overlay = document.querySelector('.mobile-menu-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeMobileMenu);
    }
});



