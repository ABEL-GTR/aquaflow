/* ==========================================================================
   AquaFlow JavaScript Logic — Hydration Tracker & Ambient Synthesizer
   ========================================================================== */

// App State
let state = {
    currentIntake: 0,
    dailyGoal: 2000,
    logs: [],
    timerInterval: 3600, // in seconds (1 hour default)
    timerRemaining: 3600,
    isTimerRunning: false,
    soundEnabled: true,
    lastActiveDate: '',
    limitReached: false
};

// Supabase Instance & Session User variables
let supabaseClient = null;
let currentUser = null;

// Timer reference
let countdownTimerId = null;

// Audio Context & Nodes (Lazy initialized)
let audioCtx = null;
let oceanNoiseNode = null;
let oceanFilterNode = null;
let oceanGainNode = null;
let oceanLfoNode = null;
let oceanLfoGainNode = null;

// Initialize app on DOM content loaded
document.addEventListener('DOMContentLoaded', () => {
    initDateDisplay();
    initSupabase();
    loadStateFromLocalStorage();
    checkDayReset();
    renderUI();
    setupEventListeners();
    updateCountdownDisplay();
});

// Register Service Worker for PWA installability
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Service worker registered with scope:', reg.scope))
            .catch(err => console.error('Service worker registration failed:', err));
    });
}

// Display Current Date in Premium Format
function initDateDisplay() {
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    const today = new Date();
    document.getElementById('current-date-str').textContent = today.toLocaleDateString('en-US', options);
    state.lastActiveDate = today.toISOString().split('T')[0];
}

/* ==========================================================================
   Supabase Database Client Integration
   ========================================================================== */

function initSupabase() {
    // If Supabase SDK loaded via CDN (exposed as window.supabase) and keys are configured
    if (typeof window.supabase !== 'undefined' && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url !== "YOUR_SUPABASE_PROJECT_URL") {
        try {
            supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
            setupAuthListener();
        } catch (e) {
            console.error("Failed to initialize Supabase client: ", e);
        }
    } else {
        console.warn("Supabase Config contains placeholder values. Running in offline/localStorage mode.");
    }
}

// Watch sign in/out events
function setupAuthListener() {
    if (!supabaseClient) return;
    
    // Check initial session
    supabaseClient.auth.getSession().then(({ data: { session } }) => {
        handleAuthStateChange(session);
    });

    // Listen to changes (login, logout, token refresh)
    supabaseClient.auth.onAuthStateChange((_event, session) => {
        handleAuthStateChange(session);
    });
}

function handleAuthStateChange(session) {
    const loginBtn = document.getElementById('btn-login-google');
    const profileDiv = document.getElementById('user-profile');
    
    if (session && session.user) {
        currentUser = session.user;
        
        // Show user details
        loginBtn.style.display = 'none';
        profileDiv.classList.remove('hidden');
        
        const metadata = currentUser.user_metadata;
        document.getElementById('user-name').textContent = metadata.full_name || currentUser.email;
        if (metadata.avatar_url) {
            document.getElementById('user-avatar').src = metadata.avatar_url;
        } else {
            // Generates placeholder letter avatar
            document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(metadata.full_name || currentUser.email)}&background=8B6508&color=fff`;
        }
        
        // Fetch cloud data and merge
        syncCloudData();
    } else {
        currentUser = null;
        
        // Reset header to guest/login
        loginBtn.style.display = 'inline-flex';
        profileDiv.classList.add('hidden');
        
        // Return to local values
        loadStateFromLocalStorage();
        renderUI();
    }
}

// Perform OAuth Login Redirect
async function signInWithGoogle() {
    if (!supabaseClient) {
        alert("Supabase credentials are not configured yet. Set them in 'supabase-config.js'.");
        return;
    }
    
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin
            }
        });
        if (error) throw error;
    } catch (e) {
        console.error("Login failure: ", e.message);
        alert("Google Sign-In failed. Check console logs.");
    }
}

// Log out user
async function signOut() {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
    } catch (e) {
        console.error("Sign out failure: ", e.message);
    }
}

// Fetch logs and settings from cloud database
async function syncCloudData() {
    if (!supabaseClient || !currentUser) return;
    
    try {
        // 1. Fetch User Settings
        let { data: settingsData, error: settingsError } = await supabaseClient
            .from('user_settings')
            .select('*')
            .eq('user_id', currentUser.id)
            .single();
            
        if (settingsError && settingsError.code === 'PGRST116') {
            // Setting profile does not exist yet, let's create a new database row with default values
            const defaultSettings = {
                user_id: currentUser.id,
                daily_goal: state.dailyGoal,
                sound_enabled: state.soundEnabled,
                timer_interval: state.timerInterval
            };
            const { error: insertErr } = await supabaseClient
                .from('user_settings')
                .insert([defaultSettings]);
            if (insertErr) console.error("Error creating database settings profile: ", insertErr);
        } else if (settingsData) {
            state.dailyGoal = settingsData.daily_goal;
            state.soundEnabled = settingsData.sound_enabled;
            state.timerInterval = settingsData.timer_interval;
        }

        // 2. Fetch Hydration Logs for TODAY
        const todayStart = new Date();
        todayStart.setHours(0,0,0,0);
        
        const { data: logsData, error: logsError } = await supabaseClient
            .from('water_logs')
            .select('*')
            .eq('user_id', currentUser.id)
            .gte('logged_at', todayStart.toISOString())
            .order('logged_at', { ascending: false });
            
        if (logsError) throw logsError;
        
        if (logsData) {
            // Map table logs to local state schema
            state.logs = logsData.map(dbLog => ({
                id: dbLog.id,
                amount: dbLog.amount,
                timestamp: new Date(dbLog.logged_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }));
            
            // Re-aggregate current intake volume and check limit
            const totalLogged = state.logs.reduce((acc, log) => acc + log.amount, 0);
            if (totalLogged >= state.dailyGoal) {
                state.limitReached = true;
                state.currentIntake = 0;
            } else {
                state.limitReached = false;
                state.currentIntake = totalLogged;
            }
        }
        
        // Sync database values locally
        saveStateToLocalStorage();
        renderUI();
    } catch (e) {
        console.error("Database synchronization failure: ", e.message);
    }
}

// Write setting adjustments back to database/local
async function uploadSettingsUpdate() {
    saveStateToLocalStorage();
    if (!supabaseClient || !currentUser) return;
    
    try {
        const payload = {
            daily_goal: state.dailyGoal,
            sound_enabled: state.soundEnabled,
            timer_interval: state.timerInterval
        };
        const { error } = await supabaseClient
            .from('user_settings')
            .update(payload)
            .eq('user_id', currentUser.id);
            
        if (error) throw error;
    } catch (e) {
        console.error("Failed to sync settings adjustments: ", e.message);
    }
}

/* ==========================================================================
   Web Audio API Synthesis Engine
   ========================================================================== */

// Lazy initialize AudioContext
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// Speak text helper function
function speakText(text) {
    if (state.soundEnabled && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.volume = 1.0;
        window.speechSynthesis.speak(utterance);
    }
}

// Play Bubble Droplet Sound (when water logged)
function playBubbleSound() {
    if (!state.soundEnabled) return;
    initAudio();

    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        // Watery pop sound curve: slide frequency upwards quickly
        const now = audioCtx.currentTime;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(850, now + 0.12);
        
        // Fast envelope volume decay
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.8, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        
        osc.start(now);
        osc.stop(now + 0.15);
    } catch (e) {
        console.error("Audio Synthesis error: ", e);
    }
}

// Play Premium Gold Chime (when timer triggers)
function playChimeSound() {
    if (!state.soundEnabled) return;
    initAudio();

    try {
        const now = audioCtx.currentTime;
        const notes = [523.25, 659.25, 783.99, 987.77]; // C5, E5, G5, B5 (Major 7th Chord)
        
        notes.forEach((freq, idx) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + (idx * 0.08)); // arpeggiated
            
            // Premium resonance chime decay
            gain.gain.setValueAtTime(0.001, now + (idx * 0.08));
            gain.gain.linearRampToValueAtTime(0.4, now + (idx * 0.08) + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + (idx * 0.08) + 1.8);
            
            osc.start(now + (idx * 0.08));
            osc.stop(now + (idx * 0.08) + 2.0);
        });
    } catch (e) {
        console.error("Chime Synthesis error: ", e);
    }
}

// Generate Brown Noise buffer for ocean wave realism
function createBrownNoiseBuffer() {
    const bufferSize = 10 * audioCtx.sampleRate; // 10 seconds of noise
    const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Brown noise filter (1st-order integration integration filter)
        output[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = output[i];
        output[i] *= 3.5; // volume adjustment
    }
    return noiseBuffer;
}

// Start Ambient Ocean Wave loop (LFO modulated brown noise)
function startOceanAmbience() {
    if (!state.soundEnabled) return;
    initAudio();

    try {
        const now = audioCtx.currentTime;

        // 1. Noise Source
        oceanNoiseNode = audioCtx.createBufferSource();
        oceanNoiseNode.buffer = createBrownNoiseBuffer();
        oceanNoiseNode.loop = true;

        // 2. Filter (representing wave resonance shifts)
        oceanFilterNode = audioCtx.createBiquadFilter();
        oceanFilterNode.type = 'lowpass';
        oceanFilterNode.frequency.setValueAtTime(250, now);
        oceanFilterNode.Q.setValueAtTime(1.0, now);

        // 3. Main gain
        oceanGainNode = audioCtx.createGain();
        oceanGainNode.gain.setValueAtTime(0.001, now); // start silent, fade in

        // Connections
        oceanNoiseNode.connect(oceanFilterNode);
        oceanFilterNode.connect(oceanGainNode);
        oceanGainNode.connect(audioCtx.destination);

        // 4. LFO (Low Frequency Oscillator) to modulate Wave Period (approx 8s cycle)
        oceanLfoNode = audioCtx.createOscillator();
        oceanLfoNode.type = 'sine';
        oceanLfoNode.frequency.setValueAtTime(0.125, now); // 1 / 8s = 0.125Hz

        // Map LFO to modulate Low-pass Filter Cutoff (rhythmically brightens/muffles sound)
        oceanLfoGainNode = audioCtx.createGain();
        oceanLfoGainNode.gain.setValueAtTime(200, now); // swing cutoff +-200Hz
        
        oceanLfoNode.connect(oceanLfoGainNode);
        oceanLfoGainNode.connect(oceanFilterNode.frequency);

        // Map LFO to modulate gain (rhythmically changes volume)
        const lfoVolumeGain = audioCtx.createGain();
        lfoVolumeGain.gain.setValueAtTime(0.12, now); // volume swing amplitude
        
        // Add offset node so LFO oscillates between positive ranges (0.05 to 0.29)
        const lfoOffset = audioCtx.createConstantSource ? audioCtx.createConstantSource() : null;
        if (lfoOffset) {
            lfoOffset.offset.setValueAtTime(0.17, now);
            lfoOffset.start(now);
            
            oceanLfoNode.connect(lfoVolumeGain);
            lfoVolumeGain.connect(oceanGainNode.gain);
            lfoOffset.connect(oceanGainNode.gain);
        } else {
            // Fallback if ConstantSource not available
            oceanLfoNode.connect(oceanGainNode.gain);
        }

        // Start modules
        oceanNoiseNode.start(now);
        oceanLfoNode.start(now);
        
        // Fade in entire ambience smoothly
        oceanGainNode.gain.linearRampToValueAtTime(0.7, now + 1.5);
    } catch (e) {
        console.error("Ambient Ocean Wave synthesis failure: ", e);
    }
}

// Stop Ambient Ocean Wave loop (fade out smoothly)
function stopOceanAmbience() {
    if (!audioCtx || !oceanGainNode) return;
    try {
        const now = audioCtx.currentTime;
        // Smooth fade out to prevent clicks
        oceanGainNode.gain.cancelScheduledValues(now);
        oceanGainNode.gain.setValueAtTime(oceanGainNode.gain.value, now);
        oceanGainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        
        // Stop nodes after fade
        setTimeout(() => {
            if (oceanNoiseNode) {
                oceanNoiseNode.stop();
                oceanNoiseNode.disconnect();
            }
            if (oceanLfoNode) {
                oceanLfoNode.stop();
                oceanLfoNode.disconnect();
            }
            if (oceanFilterNode) oceanFilterNode.disconnect();
            if (oceanGainNode) oceanGainNode.disconnect();
            if (oceanLfoGainNode) oceanLfoGainNode.disconnect();
            
            oceanNoiseNode = null;
            oceanFilterNode = null;
            oceanGainNode = null;
            oceanLfoNode = null;
            oceanLfoGainNode = null;
        }, 1300);
    } catch (e) {
        console.error("Error shutting down audio nodes: ", e);
    }
}

/* ==========================================================================
   State & Local Storage Controllers
   ========================================================================== */

function saveStateToLocalStorage() {
    localStorage.setItem('aquaflow_state', JSON.stringify(state));
}

function loadStateFromLocalStorage() {
    const saved = localStorage.getItem('aquaflow_state');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            state = { ...state, ...parsed };
            // Ensure timer isn't saved as running, pause it by default on reload
            state.isTimerRunning = false;
        } catch (e) {
            console.error("Error loading local storage state: ", e);
        }
    }
}

// Auto-reset state if date changes (new calendar day)
function checkDayReset() {
    const todayStr = new Date().toISOString().split('T')[0];
    if (state.lastActiveDate !== todayStr) {
        state.currentIntake = 0;
        state.logs = [];
        state.limitReached = false;
        state.lastActiveDate = todayStr;
        saveStateToLocalStorage();
    }
}

/* ==========================================================================
   App Core Operations
   ========================================================================== */

// Log Water Entry
async function logHydration(amount) {
    if (amount <= 0) return;
    
    checkDayReset();

    if (state.limitReached) {
        speakText("You have reached the limit if you need to drink more you must increase the limit");
        alert("You have reached the limit if you need to drink more you must increase the limit");
        return;
    }

    playBubbleSound();

    const timestampStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let willReachLimit = (state.currentIntake + amount) >= state.dailyGoal;
    
    if (supabaseClient && currentUser) {
        try {
            // Write directly to Supabase cloud table
            const { data, error } = await supabaseClient
                .from('water_logs')
                .insert([
                    { user_id: currentUser.id, amount: amount }
                ])
                .select()
                .single();
                
            if (error) throw error;
            
            if (data) {
                const newLog = {
                    id: data.id,
                    amount: amount,
                    timestamp: timestampStr
                };
                state.logs.unshift(newLog);
                state.currentIntake += amount;
                saveStateToLocalStorage();
            }
        } catch (e) {
            console.error("Cloud logging failure, falling back to local: ", e.message);
            saveLocalLog(amount, timestampStr);
        }
    } else {
        saveLocalLog(amount, timestampStr);
    }
    
    if (willReachLimit) {
        state.limitReached = true;
        state.currentIntake = 0; // reset cup to empty
        saveStateToLocalStorage();
        resetTimer(); // Deactivate timer/notifications
        renderUI();
        speakText("You have reached the limit if you need to drink more you must increase the limit");
        alert("You have reached the limit if you need to drink more you must increase the limit");
    } else {
        renderUI();
    }
}

function saveLocalLog(amount, timestampStr) {
    const newLog = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        amount: amount,
        timestamp: timestampStr
    };
    state.logs.unshift(newLog);
    state.currentIntake += amount;
    saveStateToLocalStorage();
}

// Delete Specific Entry
async function deleteLogEntry(id) {
    const idx = state.logs.findIndex(log => log.id === id);
    if (idx === -1) return;
    
    const deletedAmount = state.logs[idx].amount;

    if (supabaseClient && currentUser && isNaN(id)) {
        // If the ID is a string UUID (non-numeric), it represents a cloud record
        try {
            const { error } = await supabaseClient
                .from('water_logs')
                .delete()
                .eq('id', id)
                .eq('user_id', currentUser.id);
                
            if (error) throw error;
        } catch (e) {
            console.error("Database deletion error: ", e.message);
            alert("Could not sync deletion with cloud database. Try again.");
            return;
        }
    }

    state.logs.splice(idx, 1);
    state.currentIntake = Math.max(0, state.currentIntake - deletedAmount);
    saveStateToLocalStorage();
    renderUI();
}

// Clear History
async function clearHistory() {
    await performFullReset(true);
}

// Perform Full Reset of Timer, Cup level, and Logs
async function performFullReset(confirmUser = true) {
    if (confirmUser && !confirm("Are you sure you want to reset all of today's hydration logs and the timer?")) return;
    
    resetTimer();
    
    if (supabaseClient && currentUser) {
        try {
            const todayStart = new Date();
            todayStart.setHours(0,0,0,0);
            
            const { error } = await supabaseClient
                .from('water_logs')
                .delete()
                .eq('user_id', currentUser.id)
                .gte('logged_at', todayStart.toISOString());
                
            if (error) throw error;
        } catch (e) {
            console.error("Failed to delete database records: ", e.message);
            if (confirmUser) {
                alert("Database deletion failed. Records cleared locally only.");
            }
        }
    }
    
    state.currentIntake = 0;
    state.logs = [];
    state.limitReached = false;
    saveStateToLocalStorage();
    renderUI();
}

/* ==========================================================================
   UI Renderer Module
   ========================================================================== */

function renderUI() {
    // 1. Volumes Text updates
    document.getElementById('current-intake').textContent = state.currentIntake;
    document.getElementById('target-goal').textContent = state.dailyGoal;
    document.getElementById('daily-goal-input').value = state.dailyGoal;
    
    // 2. Calculate and render percentage
    const percent = state.dailyGoal > 0 ? Math.min(100, Math.round((state.currentIntake / state.dailyGoal) * 100)) : 0;
    document.getElementById('progress-percentage').textContent = `${percent}%`;
    
    // 3. Fluid goblet glass fill height
    const waterFillEl = document.getElementById('water-fill-level');
    waterFillEl.style.height = `${percent}%`;
    
    // Adjust waves animations visual speed based on fullness
    const waveBack = document.querySelector('.wave-back');
    const waveFront = document.querySelector('.wave-front');
    if (percent === 0) {
        waveBack.style.display = 'none';
        waveFront.style.display = 'none';
    } else {
        waveBack.style.display = 'block';
        waveFront.style.display = 'block';
    }
    
    // 4. Badges / Milestones unlocks
    updateMilestoneBadges(percent);
    
    // 5. Render History log lists
    renderLogsList();
    
    // 6. Sound Toggle switch UI sync
    document.getElementById('sound-toggle').checked = state.soundEnabled;
}

function updateMilestoneBadges(percent) {
    const badgeFirst = document.getElementById('badge-first-sip');
    const badgeHalf = document.getElementById('badge-halfway');
    const badgeFull = document.getElementById('badge-hydrated');
    
    // First Sip
    if (state.currentIntake > 0) {
        badgeFirst.classList.remove('locked');
        badgeFirst.classList.add('unlocked');
    } else {
        badgeFirst.classList.add('locked');
        badgeFirst.classList.remove('unlocked');
    }
    
    // Halfway (50%)
    if (percent >= 50) {
        badgeHalf.classList.remove('locked');
        badgeHalf.classList.add('unlocked');
    } else {
        badgeHalf.classList.add('locked');
        badgeHalf.classList.remove('unlocked');
    }
    
    // Full (100%)
    if (percent >= 100) {
        badgeFull.classList.remove('locked');
        badgeFull.classList.add('unlocked');
    } else {
        badgeFull.classList.add('locked');
        badgeFull.classList.remove('unlocked');
    }
}

function renderLogsList() {
    const listEl = document.getElementById('logs-list');
    listEl.innerHTML = '';
    
    if (state.logs.length === 0) {
        listEl.innerHTML = `<li class="empty-log-msg">No entries logged for today. Start drinking water!</li>`;
        return;
    }
    
    state.logs.forEach(log => {
        const li = document.createElement('li');
        li.className = 'log-item';
        li.innerHTML = `
            <div class="log-item-details">
                <span class="log-water-icon">💧</span>
                <div>
                    <span class="log-amount">${log.amount} ml</span>
                    <span class="log-time">logged at ${log.timestamp}</span>
                </div>
            </div>
            <button class="btn-delete-log" data-id="${log.id}" title="Remove entry">✕</button>
        `;
        listEl.appendChild(li);
    });
    
    // Delegate deletion clicks
    listEl.querySelectorAll('.btn-delete-log').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            deleteLogEntry(id);
        });
    });
}

/* ==========================================================================
   Timer & Screen Saver Engine
   ========================================================================== */

function setupTimer() {
    const select = document.getElementById('interval-select');
    state.timerInterval = parseInt(select.value, 10);
    state.timerRemaining = state.timerInterval;
    updateCountdownDisplay();
}

function toggleTimer() {
    const btn = document.getElementById('btn-timer-toggle');
    if (state.isTimerRunning) {
        // Pause timer
        clearInterval(countdownTimerId);
        state.isTimerRunning = false;
        btn.textContent = 'Start Timer';
        btn.classList.remove('active');
    } else {
        // Start timer
        initAudio(); // Warm up Web Audio
        state.isTimerRunning = true;
        btn.textContent = 'Pause Timer';
        btn.classList.add('active');
        
        countdownTimerId = setInterval(() => {
            state.timerRemaining--;
            
            if (state.timerRemaining <= 0) {
                clearInterval(countdownTimerId);
                state.isTimerRunning = false;
                btn.textContent = 'Start Timer';
                btn.classList.remove('active');
                
                // Trigger screen saver & chime
                triggerScreenSaver();
            }
            
            updateCountdownDisplay();
        }, 1000);
    }
}

function resetTimer() {
    clearInterval(countdownTimerId);
    state.isTimerRunning = false;
    const btn = document.getElementById('btn-timer-toggle');
    if (btn) {
        btn.textContent = 'Start Timer';
        btn.classList.remove('active');
    }
    setupTimer();
}

function updateCountdownDisplay() {
    const hours = Math.floor(state.timerRemaining / 3600);
    const minutes = Math.floor((state.timerRemaining % 3600) / 60);
    const seconds = state.timerRemaining % 60;
    
    const formatted = [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':');
    
    document.getElementById('timer-digits').textContent = formatted;
    
    // Update progress bar width
    const progressFill = document.getElementById('timer-bar-fill');
    const percent = (state.timerRemaining / state.timerInterval) * 100;
    progressFill.style.width = `${percent}%`;
}

// Fullscreen Screen Saver Trigger
function triggerScreenSaver() {
    const overlay = document.getElementById('screensaver');
    overlay.classList.add('active');
    
    // Play bell alert
    playChimeSound();
    
    // Start synthesizing rolling sea wave sound loop
    startOceanAmbience();
    
    // Display desktop browser notification (if permitted)
    sendBrowserNotification();

    // Voice announcement over audio
    speakText("It is time to drink water. Close your eyes, take a deep breath, and have a sip.");

    // Enable click listener on document to exit
    setTimeout(() => {
        document.addEventListener('click', dismissScreenSaver);
        document.addEventListener('keydown', dismissScreenSaver);
    }, 1000); // 1s buffer to avoid accidental double clicks
}

// Dismiss Screen Saver
function dismissScreenSaver(e) {
    // Unbind listeners
    document.removeEventListener('click', dismissScreenSaver);
    document.removeEventListener('keydown', dismissScreenSaver);
    
    const overlay = document.getElementById('screensaver');
    overlay.classList.remove('active');
    
    // Turn off ocean sound loop
    stopOceanAmbience();
    
    // Auto-restart timer
    resetTimer();
    toggleTimer();
}

/* ==========================================================================
   Desktop Web Notifications API
   ========================================================================== */

function requestNotificationPermission() {
    if (!('Notification' in window)) {
        alert("This browser does not support desktop notifications.");
        return;
    }
    
    Notification.requestPermission().then(permission => {
        const btn = document.getElementById('btn-enable-notifications');
        if (permission === 'granted') {
            btn.textContent = '🔔 Notifications Enabled';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            // Play bubble sound to confirm
            playBubbleSound();
        } else {
            btn.textContent = '🔕 Notifications Denied';
        }
    });
}

function sendBrowserNotification() {
    if ('Notification' in window && Notification.permission === 'granted') {
        const options = {
            body: 'It is time to hydrate. Take a moment, feel the tide, and enjoy a glass of water.',
            icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">💧</text></svg>',
            requireInteraction: true
        };
        const notification = new Notification('AquaFlow: Hydration Call', options);
        notification.onclick = function() {
            window.focus();
            triggerScreenSaver();
        };
    }
}

/* ==========================================================================
   Element Interactive Event Setup
   ========================================================================== */

function setupEventListeners() {
    // Google SSO click events
    document.getElementById('btn-login-google').addEventListener('click', signInWithGoogle);
    document.getElementById('btn-logout').addEventListener('click', signOut);

    // Log quick amounts
    document.querySelectorAll('.btn-quick-add').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const amount = parseInt(btn.getAttribute('data-amount'), 10);
            logHydration(amount);
        });
    });

    // Custom log
    document.getElementById('btn-add-custom').addEventListener('click', () => {
        const input = document.getElementById('custom-amount-input');
        const amount = parseInt(input.value, 10);
        if (amount && amount > 0) {
            logHydration(amount);
            input.value = '';
        } else {
            alert("Please enter a valid amount greater than 0.");
        }
    });

    // Timer controls
    document.getElementById('interval-select').addEventListener('change', () => {
        resetTimer();
        uploadSettingsUpdate();
    });
    
    document.getElementById('btn-timer-toggle').addEventListener('click', toggleTimer);
    document.getElementById('btn-timer-reset').addEventListener('click', () => performFullReset(true));
    
    // Screensaver manual trigger test
    document.getElementById('btn-trigger-screensaver').addEventListener('click', () => {
        triggerScreenSaver();
    });

    // Notification Permission
    document.getElementById('btn-enable-notifications').addEventListener('click', requestNotificationPermission);
    
    // If permission already granted, style button accordingly
    if ('Notification' in window && Notification.permission === 'granted') {
        const btn = document.getElementById('btn-enable-notifications');
        btn.textContent = '🔔 Notifications Enabled';
        btn.disabled = true;
        btn.style.opacity = '0.7';
    }

    // Settings adjustments: Daily Target Goal
    const goalInput = document.getElementById('daily-goal-input');
    goalInput.addEventListener('change', () => {
        const goal = parseInt(goalInput.value, 10);
        if (goal && goal >= 500 && goal <= 10000) {
            state.dailyGoal = goal;
            
            // Reevaluate limit and intake
            const totalLogged = state.logs.reduce((acc, log) => acc + log.amount, 0);
            if (state.dailyGoal > totalLogged) {
                state.limitReached = false;
                state.currentIntake = totalLogged;
            } else {
                state.limitReached = true;
                state.currentIntake = 0;
            }
            
            uploadSettingsUpdate();
            renderUI();
        } else {
            alert("Daily goal must be between 500ml and 10000ml.");
            goalInput.value = state.dailyGoal;
        }
    });

    // Settings adjustments: Sound Toggle
    document.getElementById('sound-toggle').addEventListener('change', (e) => {
        state.soundEnabled = e.target.checked;
        uploadSettingsUpdate();
        
        // Test audio immediately to verify sound settings change
        if (state.soundEnabled) {
            playBubbleSound();
        }
    });

    // History clear
    document.getElementById('btn-clear-history').addEventListener('click', () => performFullReset(true));
}
