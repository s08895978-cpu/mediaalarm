const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const deviceMemory = {};

// Using the Render environment variable for security
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- ROUTE 1: THE HEARTBEAT ---
app.post('/ping', (req, res) => {
    const { instance_id, chat_id, timeout_limit, shift, status } = req.body;

    if (!instance_id) {
        return res.status(400).send("Missing instance_id");
    }

    // If the instance was paused in Hunter Mode, a new heartbeat means playback resumed manually.
    const wasPaused = deviceMemory[instance_id] && deviceMemory[instance_id].isHunterPaused;
    if (wasPaused) {
        console.log(`[RESTORED] ${instance_id} has resumed playing. Hunter pause lifted.`);
    }

    // Update the ledger with fresh data and clear all alert/pause flags
    deviceMemory[instance_id] = {
        chatId: chat_id,
        timeoutLimit: parseInt(timeout_limit), 
        shift: parseInt(shift),
        lastSeen: Date.now(),
        alertSent: false, 
        crashedAt: deviceMemory[instance_id] ? deviceMemory[instance_id].crashedAt : null,
        isHunterPaused: false // Resets the pause flag on any normal heartbeat
    };

    res.status(200).send("Heartbeat logged successfully");
});

// --- ROUTE 2: HUNTER MODE (Fires instant alert & Pauses Crash Logic) ---
app.post('/popup-alert', (req, res) => {
    const { instance_id, chat_id, status } = req.body;

    if (!instance_id || !chat_id) {
        return res.status(400).send("Missing parameters for Hunter Alert");
    }

    console.log(`[${new Date().toLocaleTimeString()}] ⚠️ HUNTER ALERT triggered by: ${instance_id}`);

    // Flag this instance so the Sweeper Loop and Recovery Script ignore it
    if (deviceMemory[instance_id]) {
        deviceMemory[instance_id].isHunterPaused = true;
    }

    const messageText = `⚠️ HUNTER MODE ALERT ⚠️\n\nInstance: ${instance_id}\nIssue: Song Unavailable Popup Detected!\nAction Required: Please check this instance to identify the banned artist.`;
    
    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    axios.post(telegramUrl, {
        chat_id: chat_id,
        text: messageText
    }).then(() => {
        console.log(`Hunter Alert successfully sent to Telegram chat: ${chat_id}\n`);
        res.status(200).send("Hunter Alert processed and sent");
    }).catch((error) => {
        console.error(`Failed to send Telegram Hunter alert:`, error.message);
        res.status(500).send("Failed to send Hunter alert");
    });
});

// --- ROUTE 3: RECOVERY STATUS (For the Python .exe Script) ---
app.get('/api/recovery-status', (req, res) => {
    const currentTime = Date.now();
    const recoveryQueue = [];

    for (const [instanceId, data] of Object.entries(deviceMemory)) {
        // Only target instances that have crashed, are NOT in Hunter Mode, and have a crashed timestamp
        if (data.alertSent && !data.isHunterPaused && data.crashedAt) {
            const timeSinceCrash = currentTime - data.crashedAt;
            
            // 4 minutes = 240,000 milliseconds
            if (timeSinceCrash >= 240000) {
                recoveryQueue.push(instanceId);
            }
        }
    }

    res.status(200).json({ 
        pending_recoveries: recoveryQueue 
    });
});

// --- SHIFT CHECKING LOGIC (With 10-Minute End-of-Shift Mute) ---
function isEligibleForShiftAlert(shiftNumber) {
    const options = {
        timeZone: 'Europe/Riga',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false 
    };
    
    const latviaTimeStr = new Date().toLocaleTimeString('en-GB', options); 
    const [hourStr, minStr] = latviaTimeStr.split(':');
    
    const latviaMinutes = (parseInt(hourStr, 10) * 60) + parseInt(minStr, 10);
    const shift = parseInt(shiftNumber, 10);
    
    if (shift === 1) {
        return latviaMinutes >= 480 && latviaMinutes <= 940;
    } else if (shift === 2) {
        return latviaMinutes >= 960 && latviaMinutes <= 1420;
    } else if (shift === 3) {
        return latviaMinutes >= 1 && latviaMinutes <= 460;
    }
    
    return true; 
}

// --- THE SWEEPER LOOP ---
setInterval(() => {
    const currentTime = Date.now();
    
    for (const [instanceId, data] of Object.entries(deviceMemory)) {
        
        // 1. Skip this instance entirely if it is waiting for Gatis on a popup
        if (data.isHunterPaused) continue;

        const maxSilenceAllowed = data.timeoutLimit * 60000; 
        const timeSinceLastPing = currentTime - data.lastSeen;

        // 2. Check if it's over the limit and we haven't locked the alert yet
        if (timeSinceLastPing > maxSilenceAllowed && !data.alertSent) {
            
            // 3. Check if we are inside the active alert window
            if (isEligibleForShiftAlert(data.shift)) {
                
                console.log(`\n🚨 ALARM TRIGGERED FOR: ${instanceId} 🚨`);
                
                // Lock the alert and log the crash time for the 4-minute grace period
                deviceMemory[instanceId].alertSent = true;
                deviceMemory[instanceId].crashedAt = currentTime; 

                const messageText = `🚨 MEDIA ALARM 🚨\n\nInstance: ${instanceId}\nShift: ${data.shift}\nStatus: OFFLINE / SILENT\nSilence Duration: ${Math.floor(timeSinceLastPing / 60000)} minutes`;
                
                const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                
                axios.post(telegramUrl, {
                    chat_id: data.chatId,
                    text: messageText
                }).then(() => {
                    console.log(`Alert sent to Telegram chat. 4-minute recovery window started.\n`);
                }).catch((error) => {
                    console.error(`Failed to send Telegram alert:`, error.message);
                });

            } else {
                // SILENT MUTE: Still lock it and track crash time, but don't message Telegram
                deviceMemory[instanceId].alertSent = true;
                deviceMemory[instanceId].crashedAt = currentTime; 
                console.log(`[SILENT MUTE] ${instanceId} died outside active alert window. Tracked for silent recovery.`);
            }
        }
    }
}, 5000); 

app.listen(PORT, () => {
    console.log(`Media Alarm Server is running on port ${PORT}`);
    console.log(`Waiting for heartbeats...`);
});