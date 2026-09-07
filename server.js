const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const deviceMemory = {};
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- ROUTE 1: THE HEARTBEAT ---
app.post('/ping', (req, res) => {
    const { instance_id, chat_id, timeout_limit, shift, status } = req.body;

    // Reject missing, null, or literal "Unknown" IDs
    if (!instance_id || instance_id.toString().trim().toLowerCase() === 'unknown') {
        return res.status(400).send("Invalid or missing instance_id");
    }

    const wasPaused = deviceMemory[instance_id] && deviceMemory[instance_id].isHunterPaused;
    if (wasPaused) {
        console.log(`[RESTORED] ${instance_id} has resumed playing. Hunter pause lifted.`);
    }

    // Healthy heartbeat wipes crashed state and resets alert status
    deviceMemory[instance_id] = {
        chatId: chat_id,
        timeoutLimit: parseInt(timeout_limit, 10), 
        shift: parseInt(shift, 10),
        lastSeen: Date.now(),
        alertSent: false, 
        crashedAt: null, 
        isHunterPaused: false 
    };

    res.status(200).send("Heartbeat logged successfully");
});

// --- ROUTE 2: HUNTER MODE (Fires Instant Alert & Freezes Recovery) ---
app.post('/popup-alert', (req, res) => {
    const { instance_id, chat_id, status } = req.body;

    if (!instance_id || !chat_id) {
        return res.status(400).send("Missing parameters for Hunter Alert");
    }

    console.log(`[${new Date().toLocaleTimeString()}] ⚠️ HUNTER ALERT triggered by: ${instance_id}`);

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

// --- ROUTE 3: RECOVERY STATUS (Queried by recovery_bot.exe) ---
app.get('/api/recovery-status', (req, res) => {
    const currentTime = Date.now();
    const recoveryQueue = [];

    for (const [instanceId, data] of Object.entries(deviceMemory)) {
        if (data.alertSent && !data.isHunterPaused && data.crashedAt) {
            const timeSinceCrash = currentTime - data.crashedAt;
            
            // Queue if offline between 2 minutes (120,000ms) and 15 minutes (900,000ms)
            if (timeSinceCrash >= 120000 && timeSinceCrash <= 900000) {
                recoveryQueue.push(instanceId);
            } else if (timeSinceCrash > 900000) {
                // 15-Minute TTL Expiry: Permanently drop powered-off/ghost instances
                data.crashedAt = null;
                console.log(`[QUEUE EXPIRY] ${instanceId} offline > 15m. Dropped from recovery queue.`);
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
        return latviaMinutes >= 0 && latviaMinutes <= 460;
    }
    
    return true; 
}

// --- THE SWEEPER LOOP ---
setInterval(() => {
    const currentTime = Date.now();
    
    for (const [instanceId, data] of Object.entries(deviceMemory)) {
        if (data.isHunterPaused) continue;

        const maxSilenceAllowed = data.timeoutLimit * 60000; 
        const timeSinceLastPing = currentTime - data.lastSeen;

        if (timeSinceLastPing > maxSilenceAllowed && !data.alertSent) {
            if (isEligibleForShiftAlert(data.shift)) {
                console.log(`\n🚨 ALARM TRIGGERED FOR: ${instanceId} 🚨`);
                
                deviceMemory[instanceId].alertSent = true;
                deviceMemory[instanceId].crashedAt = currentTime; 

                const messageText = `🚨 MEDIA ALARM 🚨\n\nInstance: ${instanceId}\nShift: ${data.shift}\nStatus: OFFLINE / SILENT\nSilence Duration: ${Math.floor(timeSinceLastPing / 60000)} minutes`;
                const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                
                axios.post(telegramUrl, {
                    chat_id: data.chatId,
                    text: messageText
                }).then(() => {
                    console.log(`Alert sent to Telegram chat. 2-minute recovery window started.\n`);
                }).catch((error) => {
                    console.error(`Failed to send Telegram alert:`, error.message);
                });

            } else {
                // Out of shift: Lock alert to silence Telegram, set crashedAt to null to hide from bot
                deviceMemory[instanceId].alertSent = true;
                deviceMemory[instanceId].crashedAt = null; 
                console.log(`[SILENT MUTE] ${instanceId} closed outside active shift. Ignored by recovery bot.`);
            }
        }
    }
}, 5000); 

app.listen(PORT, () => {
    console.log(`Media Alarm Server is running on port ${PORT}`);
    console.log(`Waiting for heartbeats...`);
});