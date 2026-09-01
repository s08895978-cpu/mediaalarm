const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const deviceMemory = {};

// Using the Render environment variable for security
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.post('/ping', (req, res) => {
    const { instance_id, chat_id, timeout_limit, shift, status } = req.body;

    if (!instance_id) {
        return res.status(400).send("Missing instance_id");
    }

    console.log(`[${new Date().toLocaleTimeString()}] Heartbeat from: ${instance_id}`);

    // Update the ledger with fresh data and reset the alarm lock
    deviceMemory[instance_id] = {
        chatId: chat_id,
        timeoutLimit: parseInt(timeout_limit), 
        shift: parseInt(shift),
        lastSeen: Date.now(),
        alertSent: false // Automatically resets so it can fail/alert again later
    };

    res.status(200).send("Heartbeat logged successfully");
});

// --- SHIFT CHECKING LOGIC (With 10-Minute End-of-Shift Mute) ---
function isEligibleForShiftAlert(shiftNumber) {
    // 1. Get current time in Latvia (Europe/Riga), handling DST automatically
    const options = {
        timeZone: 'Europe/Riga',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false // Force 24-hour format
    };
    
    // Returns format "HH:MM" based on current Latvian time
    const latviaTimeStr = new Date().toLocaleTimeString('en-GB', options); 
    const [hourStr, minStr] = latviaTimeStr.split(':');
    
    // Convert current time to total minutes from midnight for easy math
    const latviaMinutes = (parseInt(hourStr, 10) * 60) + parseInt(minStr, 10);
    const shift = parseInt(shiftNumber, 10);
    
    if (shift === 1) {
        // 1st shift: 08:00 (480 mins) to 15:50 (950 mins)
        // Alert window: 08:00 (480 mins) to 15:40 (940 mins) -> Last 10 mins muted
        return latviaMinutes >= 480 && latviaMinutes <= 940;
    } else if (shift === 2) {
        // 2nd shift: 16:00 (960 mins) to 23:50 (1430 mins)
        // Alert window: 16:00 (960 mins) to 23:40 (1420 mins) -> Last 10 mins muted
        return latviaMinutes >= 960 && latviaMinutes <= 1420;
    } else if (shift === 3) {
        // 3rd shift: 00:01 (1 min) to 07:50 (470 mins)
        // Alert window: 00:01 (1 min) to 07:40 (460 mins) -> Last 10 mins muted
        return latviaMinutes >= 1 && latviaMinutes <= 460;
    }
    
    // Default to true if shift is unknown so we don't accidentally miss an alert
    return true; 
}

// --- THE SWEEPER LOOP ---
setInterval(() => {
    const currentTime = Date.now();
    
    for (const [instanceId, data] of Object.entries(deviceMemory)) {
        
        // Production math (minutes -> milliseconds)
        const maxSilenceAllowed = data.timeoutLimit * 60000; 
        const timeSinceLastPing = currentTime - data.lastSeen;

        // 1. Check if it's over the limit
        // 2. Check if we haven't sent an alert yet (The Lock)
        // 3. Check if we are inside the active alert window (ignoring last 10 mins of shift)
        if (timeSinceLastPing > maxSilenceAllowed && !data.alertSent && isEligibleForShiftAlert(data.shift)) {
            
            console.log(`\n🚨 ALARM TRIGGERED FOR: ${instanceId} 🚨`);
            
            // Lock the alert so it only sends once per failure
            deviceMemory[instanceId].alertSent = true;

            const messageText = `🚨 MEDIA ALARM 🚨\n\nInstance: ${instanceId}\nShift: ${data.shift}\nStatus: OFFLINE / SILENT\nSilence Duration: ${Math.floor(timeSinceLastPing / 60000)} minutes`;
            
            const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
            
            axios.post(telegramUrl, {
                chat_id: data.chatId,
                text: messageText
            }).then(() => {
                console.log(`Alert successfully sent to Telegram chat: ${data.chatId}\n`);
            }).catch((error) => {
                console.error(`Failed to send Telegram alert:`, error.message);
            });
        }
    }
}, 5000); // Scans the memory ledger every 5 seconds

app.listen(PORT, () => {
    console.log(`Media Alarm Server is running on port ${PORT}`);
    console.log(`Waiting for heartbeats...`);
});