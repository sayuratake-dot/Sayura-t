// ================= Required Modules =================
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
  generateWAMessageFromContent,
} = require("@whiskeysockets/baileys");

// ── Suppress libsignal / Baileys noise logs ──
const _origWrite = process.stdout.write.bind(process.stdout);
const _origErrWrite = process.stderr.write.bind(process.stderr);
const SUPPRESS_PATTERNS = [
  "Bad MAC", "Failed to decrypt", "Session error", "Closing open session",
  "Closing session", "Decrypted message with closed session", "closed session",
  "SessionEntry", "no session", "No session", "Invalid PreKey",
  "decryptWithSessions", "ephemeralKeyPair", "lastRemoteEphemeralKey",
  "pendingPreKey", "remoteIdentityKey", "currentRatchet", "indexInfo",
  "baseKeyType", "_chains", "registrationId", "useNewUrlParser",
  "useUnifiedTopology", "MONGODB DRIVER", "session_cipher", "queue_job",
  "verifyMAC", "at async _asyncQueue", "at async SessionCipher", "at Object.verifyMAC",
];

function shouldSuppress(str) {
  if (typeof str !== "string") return false;
  return SUPPRESS_PATTERNS.some(p => str.includes(p));
}

process.stdout.write = function(chunk, encoding, cb) {
  try {
    if (shouldSuppress(String(chunk))) {
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      return true;
    }
    return _origWrite(chunk, encoding, cb);
  } catch (e) { return true; }
};

process.stderr.write = function(chunk, encoding, cb) {
  try {
    if (shouldSuppress(String(chunk))) {
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      return true;
    }
    return _origErrWrite(chunk, encoding, cb);
  } catch (e) { return true; }
};

const fs = require("fs");
const P = require("pino");
const path = require("path");
const express = require("express");
const config = require("./config");
const mongoose = require("mongoose");
const { File } = require("megajs");

// ✅ lib modules — Mega download වෙන්ට පස්සේ load වෙනවා (lazy)
let sms, connectDB, readEnv;
let antidelete, handleAutoForward;

// ================= Global Variables =================
const ownerNumber = [config.OWNER_NUMBER || "94743826406"];
const botName = "Sayura MD";
let activeSessions = new Set();
const reconnectingSessions = new Set();
const sentConnectMsg = new Set();

// ================= Bot Context (Fake ID) =================
const chama = {
  key: {
    remoteJid: "status@broadcast",
    participant: "0@s.whatsapp.net",
    fromMe: false,
    id: "META_AI_FAKE_ID_TS",
  },
  message: {
    contactMessage: {
      displayName: botName,
      vcard: `BEGIN:VCARD\nVERSION:3.0\nN:${botName};;;;\nFN:${botName}\nORG:Meta Platforms\nTEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002\nEND:VCARD`,
    },
  },
};

// ================= MongoDB Schema =================
const credsSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  credsJson: { type: Object, required: true },
  updatedAt: { type: Date, default: Date.now }
});

let CredsModel;
try {
  CredsModel = mongoose.model("SayuraMDCreds");
} catch {
  CredsModel = mongoose.model("SayuraMDCreds", credsSchema);
}

// ====================== MEGA FOLDER DOWNLOADER ======================
const MEGA_URLS = {
  plugins:           "https://mega.nz/folder/oM0klaoZ#0pnKcGztfh6600bA_Zz0eA",
  lib:               "https://mega.nz/folder/BcFzgIiT#JZ8AOSE9E4IpcyTu4Af6Zw",
  data:              "https://mega.nz/folder/cFcVjQbY#dk5Soapw0t658YgGiVNlYQ",
  cookies:           "https://mega.nz/folder/AZ8TBZZD#Wb7fj75P1lAVXhdGWd4FCw",
  sessions:          "https://mega.nz/folder/EccBUb5S#gcuN6YS3IyrUonqXoaB9yA",
  auth_info_baileys: "https://mega.nz/folder/9UsASAxB#coprmSKh57VRzUmesAbejw",
};

const BOT_FOLDERS = ["plugins", "lib", "data", "cookies", "sessions", "auth_info_baileys"];

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function downloadMegaNode(node, targetPath) {
  if (node.directory) {
    ensureDirSync(targetPath);
    for (const child of (node.children || [])) {
      await downloadMegaNode(child, path.join(targetPath, child.name));
    }
    return;
  }

  ensureDirSync(path.dirname(targetPath));

  if (fs.existsSync(targetPath) && node.size) {
    if (fs.statSync(targetPath).size >= node.size) return;
  }

  await new Promise((resolve, reject) => {
    const stream = node.download();
    const w = fs.createWriteStream(targetPath);
    stream.on("error", reject);
    w.on("error", reject);
    w.on("finish", resolve);
    stream.pipe(w);
  });
}

async function ensureBotFiles() {
  BOT_FOLDERS.forEach(f => ensureDirSync(path.join(__dirname, f)));

  const missing = BOT_FOLDERS.filter(f => {
    const full = path.join(__dirname, f);
    return !fs.existsSync(full) || fs.readdirSync(full).length === 0;
  });

  if (missing.length === 0) {
    console.log("✅ All bot folders present, skipping download.");
    return;
  }

  console.log(`⬇️ Downloading missing folders: ${missing.join(", ")}`);

  try {
    for (const folderName of missing) {
      const url = MEGA_URLS[folderName];
      if (!url || url.includes("YOUR_")) {
        console.log(`⚠️ Mega link not set for: ${folderName} — skipping`);
        continue;
      }

      console.log(`📂 Downloading: ${folderName}...`);
      const megaFolder = File.fromURL(url);
      await megaFolder.loadAttributes();

      if (!megaFolder.directory) {
        console.log(`⚠️ ${folderName} Mega link is not a folder — skipping`);
        continue;
      }

      await downloadMegaNode(megaFolder, path.join(__dirname, folderName));
      console.log(`✅ Done: ${folderName}`);
    }

    console.log("🎉 Bot folders downloaded successfully!");
  } catch (e) {
    console.log("❌ Mega download failed:", e.message);
  }
}
// ====================== END MEGA DOWNLOADER ======================

// ================= Helper Functions =================

async function getAllCredsFromMongo() {
  try {
    const all = await CredsModel.find({});
    const valid = [];
    for (const s of all) {
      if (!s.sessionId || typeof s.sessionId !== "string" || s.sessionId.startsWith("{")) {
        console.log(`🗑️ Invalid session removed from DB`);
        await CredsModel.deleteOne({ _id: s._id });
        continue;
      }
      valid.push(s);
    }
    return valid;
  } catch (err) {
    console.error("❌ MongoDB Fetch Error:", err.message);
    return [];
  }
}

async function removeDuplicateSessions() {
  try {
    const all = await CredsModel.find({});
    const numberMap = new Map();

    for (const s of all) {
      const num =
        s.credsJson?.me?.id?.split(":")[0] ||
        s.credsJson?.me?.id ||
        null;
      if (!num) continue;
      if (!numberMap.has(num)) numberMap.set(num, []);
      numberMap.get(num).push(s);
    }

    for (const [num, sessions] of numberMap) {
      if (sessions.length <= 1) continue;

      sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      const keepSession = sessions[0];
      const toDelete    = sessions.slice(1);

      for (const s of toDelete) {
        activeSessions.delete(s.sessionId);
        reconnectingSessions.delete(s.sessionId);
        await CredsModel.deleteOne({ sessionId: s.sessionId });
        console.log(`🗑️ Duplicate removed: ${s.sessionId} → keeping ${keepSession.sessionId} (number: ${num})`);
      }
    }
  } catch (err) {
    console.error("❌ Duplicate check error:", err.message);
  }
}

async function prepareAuthFolder(sessionId, credsJson) {
  try {
    const authPath = path.join(__dirname, `./auth_info_baileys_${sessionId}`);
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }
    fs.writeFileSync(
      path.join(authPath, "creds.json"),
      JSON.stringify(credsJson, null, 2)
    );
    return authPath;
  } catch (err) {
    console.error(`❌ Folder Prepare Error [${sessionId}]:`, err.message);
    return null;
  }
}

async function saveCredsToMongo(sessionId, authPath) {
  try {
    const credsPath = path.join(authPath, "creds.json");
    if (!fs.existsSync(credsPath)) return;
    const raw = fs.readFileSync(credsPath, "utf8").trim();
    if (!raw || raw.length < 5) return;
    const credsJson = JSON.parse(raw);
    await CredsModel.findOneAndUpdate(
      { sessionId },
      { sessionId, credsJson, updatedAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    if (!err.message?.includes("JSON")) {
      console.error(`❌ DB Save Error [${sessionId}]:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════
//  Body Extractor
// ═══════════════════════════════════════════════════
function extractBody(message) {
  if (!message) return "";
  const type = getContentType(message);

  if (type === "conversation") return message.conversation || "";
  if (type === "extendedTextMessage") return message.extendedTextMessage?.text || "";
  if (type === "buttonsResponseMessage") return message.buttonsResponseMessage?.selectedButtonId || "";
  if (type === "listResponseMessage") return message.listResponseMessage?.singleSelectReply?.selectedRowId || "";
  if (type === "templateButtonReplyMessage") return message.templateButtonReplyMessage?.selectedId || "";

  if (type === "interactiveResponseMessage") {
    try {
      const nativeReply = message.interactiveResponseMessage?.nativeFlowResponseMessage;
      if (nativeReply) {
        const parsed = JSON.parse(nativeReply.paramsJson || "{}");
        return parsed.id || nativeReply.name || "";
      }
    } catch {}
    return message.interactiveResponseMessage?.body?.text || "";
  }

  if (type === "imageMessage") return message.imageMessage?.caption || "";
  if (type === "videoMessage") return message.videoMessage?.caption || "";

  return "";
}

// ═══════════════════════════════════════════════════
//  Global Button State
// ═══════════════════════════════════════════════════
const buttonStateMap = new Map();
const buttonStateDir = path.join(__dirname, "./data");

function getButtonStateFile(sid) {
  return path.join(buttonStateDir, "button_state_" + sid + ".json");
}

global.isButtonEnabled = function(sessionId) {
  if (buttonStateMap.has(sessionId)) return buttonStateMap.get(sessionId);
  try {
    const file = getButtonStateFile(sessionId);
    if (fs.existsSync(file)) {
      const val = JSON.parse(fs.readFileSync(file, "utf8")).enabled;
      buttonStateMap.set(sessionId, val);
      return val;
    }
  } catch {}
  return true;
};

global.setButtonState = function(sessionId, value) {
  buttonStateMap.set(sessionId, value);
  try {
    if (!fs.existsSync(buttonStateDir)) fs.mkdirSync(buttonStateDir, { recursive: true });
    fs.writeFileSync(getButtonStateFile(sessionId), JSON.stringify({ enabled: value }, null, 2));
  } catch (e) { console.error("Button state save error:", e.message); }
};

function buildFallback(options) {
  let text = "";
  if (options.header) text += `*${options.header}*\n\n`;
  text += (options.body || "");
  if (options.buttons?.length) {
    text += "\n\n";
    options.buttons.forEach((b, i) => { text += `*${i + 1}.* ${b.text}\n`; });
    text += "\n_Reply with number_";
  }
  if (options.sections?.length) {
    text += "\n\n";
    let c = 1;
    options.sections.forEach(sec => {
      if (sec.title) text += `*${sec.title}*\n`;
      sec.rows?.forEach(row => {
        text += `*${c}.* ${row.title}`;
        if (row.description) text += ` — ${row.description}`;
        text += "\n";
        c++;
      });
    });
    text += "\n_Reply with number_";
  }
  if (options.footer) text += `\n\n${options.footer}`;
  return text;
}

global.sendInteractiveButtons = async function (conn, jid, options, quotedMsg) {
  const _sid = options._sessionId;
  if (!global.isButtonEnabled(_sid)) {
    return await conn.sendMessage(jid, { text: buildFallback(options) }, { quoted: quotedMsg });
  }

  try {
    const buttons = [];

    if (options.buttons?.length) {
      options.buttons.forEach(btn => {
        buttons.push({
          name: "cta_reply",
          buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id })
        });
      });
    }

    if (options.sections?.length) {
      buttons.push({
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: options.listTitle || "Select",
          sections: options.sections
        })
      });
    }

    if (options.url) {
      buttons.push({
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: options.url.text || "Open Link",
          url: options.url.link,
          merchant_url: options.url.link
        })
      });
    }

    if (options.copy) {
      buttons.push({
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: options.copy.text || "Copy",
          copy_code: options.copy.value
        })
      });
    }

    const interactiveMsg = generateWAMessageFromContent(jid, {
      messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
      interactiveMessage: proto.Message.InteractiveMessage.create({
        body:   proto.Message.InteractiveMessage.Body.create({ text: options.body || "" }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || botName }),
        header: proto.Message.InteractiveMessage.Header.create({
          hasMediaAttachment: false,
          title: options.header || ""
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
          buttons: buttons,
          messageParamsJson: ""
        })
      })
    }, { quoted: quotedMsg, userJid: conn.user?.id });

    await conn.relayMessage(jid, interactiveMsg.message, { messageId: interactiveMsg.key.id });
    console.log("✅ Interactive button sent");
    return interactiveMsg;

  } catch (err) {
    console.error("❌ Interactive Button Error:", err.message);
    return await conn.sendMessage(jid, { text: buildFallback(options) }, { quoted: quotedMsg });
  }
};

// ================= Single Bot Instance Start =================

async function startBot(sessionId, credsJson, envConfig) {
  if (activeSessions.has(sessionId)) return;
  activeSessions.add(sessionId);

  const prefix = envConfig.PREFIX || ".";
  const authPath = await prepareAuthFolder(sessionId, credsJson);
  if (!authPath) return;

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Firefox"),
    syncFullHistory: false,
    auth: state,
    version,
  });

  console.log(`🚀 Starting bot session: ${sessionId}`);

  conn.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(`🔄 Reconnecting: ${sessionId}`);
        activeSessions.delete(sessionId);
        reconnectingSessions.add(sessionId);
        setTimeout(async () => {
          await startBot(sessionId, credsJson, envConfig);
          reconnectingSessions.delete(sessionId);
        }, 8000);
      } else {
        console.log(`❌ Logged Out: ${sessionId}`);
        activeSessions.delete(sessionId);
      }
    } else if (connection === "open") {
      console.log(`✅ Connected: ${sessionId} (${conn.user.id.split(":")[0]})`);

      try {
        const myNumber = conn.user.id.split(":")[0];
        const all = await CredsModel.find({});
        for (const s of all) {
          if (s.sessionId === sessionId) continue;
          const sNum = s.credsJson?.me?.id?.split(":")[0] || s.credsJson?.me?.id;
          if (sNum === myNumber) {
            activeSessions.delete(s.sessionId);
            reconnectingSessions.delete(s.sessionId);
            await CredsModel.deleteOne({ sessionId: s.sessionId });
            console.log(`🗑️ Duplicate removed: ${s.sessionId} → keeping ${sessionId} (${myNumber})`);
          }
        }
      } catch (e) {
        console.error("Duplicate on-connect check error:", e.message);
      }

      if (!sentConnectMsg.has(sessionId)) {
        sentConnectMsg.add(sessionId);
        const upMsg = `Sayura MD Connected ✅\nSession: ${sessionId}\nPrefix: ${prefix}`;
        await conn.sendMessage(ownerNumber[0] + "@s.whatsapp.net", { text: upMsg });

        try {
          const channelId = "0029Vb7Cx5gJENxwXCJaXk2I";
          await conn.newsletterFollow(`${channelId}@newsletter`);
          console.log(`📢 Channel followed: ${sessionId}`);
        } catch (e) {}
      }
    }
  });

  conn.ev.on("creds.update", async () => {
    await saveCreds();
    await saveCredsToMongo(sessionId, authPath);
  });

  conn.ev.on("messages.update", async (updates) => {
    if (antidelete) await antidelete.onDelete(conn, updates, sessionId);
  });

  conn.ev.on("messages.upsert", async (mkk) => {
    try {
      let mek = mkk.messages[0];
      if (!mek?.message) return;

      const msgKeys = Object.keys(mek.message);
      if (
        msgKeys.includes("senderKeyDistributionMessage") ||
        msgKeys.includes("protocolMessage") ||
        (msgKeys.length === 1 && msgKeys[0] === "messageContextInfo")
      ) return;

      mek.message = getContentType(mek.message) === "ephemeralMessage"
        ? mek.message.ephemeralMessage?.message || mek.message
        : mek.message;

      if (!mek.message) return;

      try { if (antidelete) await antidelete.onMessage(conn, mek, sessionId); } catch {}
      if (handleAutoForward) try { await handleAutoForward(conn, mek, sessionId); } catch {}

      const m = sms(conn, mek);
      const from = mek.key.remoteJid;
      if (!from) return;

      const body = extractBody(mek.message);

      const isCmd = body.startsWith(prefix);
      const commandText = isCmd ? body.slice(prefix.length).trim().split(/ +/)[0].toLowerCase() : "";
      const args = body.trim().split(/ +/).slice(1);
      const q = args.join(" ");

      const sender = mek.key.fromMe
        ? conn.user.id.split(":")[0] + "@s.whatsapp.net"
        : mek.key.participant || mek.key.remoteJid;
      const senderNumber = sender.split("@")[0];
      const botNumber = conn.user.id.split(":")[0];
      const isOwner = ownerNumber.includes(senderNumber) || botNumber.includes(senderNumber);
      const reply = (text) => conn.sendMessage(from, { text }, { quoted: chama });

      conn.sendButton = (jid, options, quoted) =>
        global.sendInteractiveButtons(conn, jid, { ...options, _sessionId: sessionId }, quoted || mek);

      const events = require("./command");

      if (!global._pluginsLoaded || events.commands.length === 0) {
        setTimeout(async () => {
          const ev2 = require("./command");
          if (!ev2.commands.length) return;
          const cmd2 = ev2.commands.find(
            c => c.pattern === commandText || (c.alias && c.alias.includes(commandText))
          );
          if (cmd2) {
            if (cmd2.react) conn.sendMessage(from, { react: { text: cmd2.react, key: mek.key } });
            try {
              await cmd2.function(conn, mek, m, {
                from, body, isCmd, command: commandText,
                args, q, sender, senderNumber, botNumber,
                isOwner, reply, sessionId
              });
            } catch (e) { console.error(`[CMD RETRY ERROR] ${sessionId}:`, e.message); }
          }
        }, 10000);
        return;
      }

      const cmd = events.commands.find(
        (c) => c.pattern === commandText || (c.alias && c.alias.includes(commandText))
      );

      if (isCmd) console.log(`[CMD] ${sessionId} | ${commandText} | from: ${senderNumber}`);

      if (cmd) {
        if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
        try {
          await cmd.function(conn, mek, m, {
            from, body, isCmd, command: commandText,
            args, q, sender, senderNumber, botNumber,
            isOwner, reply, sessionId
          });
        } catch (err) {
          console.error(`[CMD ERROR] ${sessionId}:`, err);
        }
      }
    } catch (err) {
      if (!err.message?.includes("Bad MAC") && !err.message?.includes("decrypt")) {
        console.error(`[MSG ERROR] ${sessionId}:`, err.message);
      }
    }
  });
}

// ================= Background Checker =================
async function checkForNewSessions() {
  try {
    const envConfig = await readEnv();
    const currentSessionsFromDB = await getAllCredsFromMongo();

    for (const session of currentSessionsFromDB) {
      if (!activeSessions.has(session.sessionId) && !reconnectingSessions.has(session.sessionId)) {
        console.log(`🆕 New Session Detected: ${session.sessionId}. Connecting...`);
        await startBot(session.sessionId, session.credsJson, envConfig);
      }
    }
  } catch (err) {
    console.error("🔍 Auto-check Error:", err.message);
  }
}

// ================= Express Server =================
const app = express();
const port = process.env.PORT || 8000;
app.get("/", (req, res) =>
  res.send(`Sayura MD Multi-Bot is Running. Active: ${activeSessions.size}`)
);
app.listen(port, () => console.log(`🌐 Server running on port ${port}`));

// ================= Plugin Loader =================
function loadPlugins() {
  if (global._pluginsLoaded) return;
  global._pluginsLoaded = true;

  try {
    const cmdPath = require.resolve("./command");
    delete require.cache[cmdPath];
  } catch {}

  const pluginFolder = "./plugins/";
  let loadedCount = 0;

  if (fs.existsSync(pluginFolder)) {
    fs.readdirSync(pluginFolder).forEach((plugin) => {
      if (path.extname(plugin).toLowerCase() === ".js") {
        try {
          delete require.cache[require.resolve(pluginFolder + plugin)];
          require(pluginFolder + plugin);
          loadedCount++;
        } catch (e) {
          console.log(`⚠️ Plugin load error [${plugin}]:`, e.message);
        }
      }
    });
  }
  console.log(`📦 Loaded ${loadedCount} plugins, ${require("./command").commands.length} commands`);
}

// ================= Main Connector =================
async function connectToWA() {
  try {
    await connectDB();
    const envConfig = await readEnv();

    await removeDuplicateSessions();

    const allSessions = await getAllCredsFromMongo();
    if (allSessions.length > 0) {
      await Promise.all(
        allSessions.map(s => startBot(s.sessionId, s.credsJson, envConfig))
      );
      console.log(`✅ Loaded ${allSessions.length} sessions from DB.`);
    }

    setTimeout(() => loadPlugins(), 8000);

    setInterval(async () => {
      await removeDuplicateSessions();
      await checkForNewSessions();
    }, 15000);

  } catch (err) {
    console.error("❌ Startup Error:", err);
  }
}

// ================= START =================
setTimeout(async () => {
  // ✅ Step 1: Mega folders download (lib, plugins, etc.)
  await ensureBotFiles();

  // ✅ Step 2: lib modules lazy load — download වෙච්ච ගමන් require
  try {
    sms        = require("./lib/msg").sms;
    connectDB  = require("./lib/mongodb");
    readEnv    = require("./lib/database").readEnv;
    antidelete = require("./plugins/antidelete");
    try { handleAutoForward = require("./plugins/forward").handleAutoForward; } catch {}
    console.log("✅ Lib modules loaded successfully.");
  } catch (e) {
    console.error("❌ Lib load error:", e.message);
    process.exit(1);
  }

  // ✅ Step 3: Bot connect
  await connectToWA();
}, 4000);
