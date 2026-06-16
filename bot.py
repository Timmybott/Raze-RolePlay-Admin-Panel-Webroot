import discord
from discord.ext import commands, tasks
import asyncio
import json
import os
import sys
import time
import math
import base64
import hashlib
import hmac
import secrets
from collections import deque
from aiohttp import web
import uuid

# --- CONFIGURATION LOADING ---
# Load config relative to this script file to avoid CWD issues
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
FIVEM_CONFIG_FILE = os.path.join(BASE_DIR, 'fivem_config.json')
CONFIG = {}
FIVEM_CONFIG = {}

# --- TOKEN-VERSCHLÜSSELUNG ---
# Der Discord-Token wird NICHT im Klartext in config.json gespeichert, sondern als
# "enc:v1:..."-Blob. Beim Laden wird er im Code entschlüsselt.
#
# Schlüssel: Für echten Schutz die Umgebungsvariable RAZE_TOKEN_KEY setzen
# (dann reichen config.json + bot.py allein NICHT zum Auslesen). Ohne gesetzte
# Variable wird ein eingebauter Standardschlüssel benutzt -> schützt vor
# versehentlichem Klartext-Leak (Backups, Screenshots, Weitergabe der config.json),
# aber nicht vor jemandem, der zusätzlich den Bot-Code hat.
TOKEN_PREFIX = "enc:v1:"
_DEFAULT_TOKEN_KEY = "RazeRoleplay::token-vault::v1"

def _token_secret():
    return (os.environ.get("RAZE_TOKEN_KEY") or _DEFAULT_TOKEN_KEY).encode("utf-8")

def _derive_key(salt):
    return hashlib.pbkdf2_hmac("sha256", _token_secret(), salt, 200_000)

def _keystream(key, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + counter.to_bytes(4, "big")).digest()
        counter += 1
    return bytes(out[:length])

def is_token_encrypted(value):
    return isinstance(value, str) and value.startswith(TOKEN_PREFIX)

def encrypt_token(plaintext):
    data = plaintext.encode("utf-8")
    salt = secrets.token_bytes(16)
    key = _derive_key(salt)
    cipher = bytes(b ^ k for b, k in zip(data, _keystream(key, len(data))))
    mac = hmac.new(key, salt + cipher, hashlib.sha256).digest()[:16]
    blob = base64.urlsafe_b64encode(salt + cipher + mac).decode("ascii")
    return TOKEN_PREFIX + blob

def decrypt_token(value):
    """Entschlüsselt einen 'enc:v1:'-Token. Klartext wird unverändert zurückgegeben
    (Abwärtskompatibilität)."""
    if not is_token_encrypted(value):
        return value
    raw = base64.urlsafe_b64decode(value[len(TOKEN_PREFIX):].encode("ascii"))
    salt, cipher, mac = raw[:16], raw[16:-16], raw[-16:]
    key = _derive_key(salt)
    if not hmac.compare_digest(mac, hmac.new(key, salt + cipher, hashlib.sha256).digest()[:16]):
        raise ValueError("Token-Entschlüsselung fehlgeschlagen (falscher RAZE_TOKEN_KEY?).")
    return bytes(c ^ k for c, k in zip(cipher, _keystream(key, len(cipher)))).decode("utf-8")

def get_bot_token():
    try:
        return decrypt_token(CONFIG.get("TOKEN", ""))
    except Exception as e:
        print(f"FEHLER beim Entschlüsseln des Bot-Tokens: {e}")
        return ""

def normalize_config_types():
    """Stellt sicher, dass IDs aus JSON/Panel als int vorliegen, wo der Bot ints erwartet.
    (JSON-Objekt-Keys sind immer Strings; das Panel sendet IDs ebenfalls als Strings.)"""
    def to_int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return v

    if isinstance(CONFIG.get("VOTE_CHANNELS"), dict):
        CONFIG["VOTE_CHANNELS"] = {to_int(k): v for k, v in CONFIG["VOTE_CHANNELS"].items()}
    if isinstance(CONFIG.get("ROLE_SYNC_MAPPING"), dict):
        CONFIG["ROLE_SYNC_MAPPING"] = {
            to_int(k): [to_int(r) for r in v] for k, v in CONFIG["ROLE_SYNC_MAPPING"].items()
        }
    for key in ("WAITING_ROOMS", "THUMBS_UP_CHANNELS", "TICKET_PERMANENT_ADMINS"):
        if isinstance(CONFIG.get(key), list):
            CONFIG[key] = [to_int(v) for v in CONFIG[key]]
    if isinstance(CONFIG.get("TICKET_TYPES"), dict):
        for ticket_type in CONFIG["TICKET_TYPES"].values():
            if isinstance(ticket_type, dict) and isinstance(ticket_type.get("roles"), list):
                ticket_type["roles"] = [to_int(r) for r in ticket_type["roles"]]
    for key in ("GUILD_ID", "CHANNEL_ID", "VERIFY_CHANNEL_ID", "WELCOME_CHANNEL_ID",
                "IMAGE_ONLY_CHANNEL_ID", "VIDEO_ONLY_CHANNEL_ID", "FEEDBACK_CHANNEL_ID",
                "VERIFY_ROLE_ID", "TARGET_USER_ID", "TICKET_CHANNEL_ID", "TICKET_CATEGORY_OPEN",
                "TICKET_CATEGORY_CLOSED", "TICKET_LOG_CHANNEL_ID", "ACCENT_COLOR"):
        if isinstance(CONFIG.get(key), str) and CONFIG[key].isdigit():
            CONFIG[key] = int(CONFIG[key])

def load_config():
    global CONFIG
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            CONFIG = json.load(f)

        normalize_config_types()

        # Token automatisch verschlüsseln, falls er noch im Klartext vorliegt
        token = CONFIG.get("TOKEN")
        if token and not is_token_encrypted(token):
            try:
                CONFIG["TOKEN"] = encrypt_token(token)
                save_config()
                print("Bot-Token war im Klartext und wurde verschlüsselt in config.json gespeichert.")
            except Exception as e:
                print(f"Konnte Token nicht verschlüsseln: {e}")

        print("Konfiguration (Discord) erfolgreich geladen.")
    except Exception as e:
        print(f"Fehler beim Laden der Discord-Konfiguration: {e}")

# Alte Standard-Ban-Nachricht (für die Migration auf die Variante mit [Zeit]/[Restzeit])
OLD_DEFAULT_BAN_MESSAGE = ("\n\nDu wurdest von diesem Server gebannt.\n\nGrund: [Grund]\n\n"
                           "Melde dich bitte auf unserem Discord: https://dc.gg/razerp")
DEFAULT_BAN_MESSAGE = ("\n\nDu wurdest von diesem Server gebannt.\n\nGrund: [Grund]\n\n"
                       "Bann-Dauer: [Zeit]\nVerbleibend: [Restzeit]\n\n"
                       "Melde dich bitte auf unserem Discord: https://dc.gg/razerp")
DEFAULT_KICK_MESSAGE = ("\n\nDu wurdest von diesem Server gekickt.\n\nGrund: [Grund]\n\n"
                        "Bei Fragen melde dich auf unserem Discord: https://dc.gg/razerp")

def load_fivem_config():
    global FIVEM_CONFIG
    try:
        if not os.path.exists(FIVEM_CONFIG_FILE):
            # Create default if not exists
            FIVEM_CONFIG = {
                "FIVEM_WHITELIST_ENABLED": False,
                "FIVEM_BANLIST_ENABLED": False,
                "FIVEM_WHITELIST_ROLE_ENABLED": False,
                "FIVEM_WHITELIST_ROLE_ID": None,
                "FIVEM_WHITELIST_MESSAGE": "Du bist nicht auf der Whitelist.",
                "FIVEM_BANLIST_MESSAGE": DEFAULT_BAN_MESSAGE,
                "FIVEM_KICK_MESSAGE": DEFAULT_KICK_MESSAGE,
                "FIVEM_WHITELIST": [],
                "FIVEM_BANLIST": []
            }
            save_fivem_config()
        else:
            with open(FIVEM_CONFIG_FILE, 'r', encoding='utf-8') as f:
                FIVEM_CONFIG = json.load(f)
            # Fehlende Kick-Nachricht ergänzen (Migration)
            if "FIVEM_KICK_MESSAGE" not in FIVEM_CONFIG:
                FIVEM_CONFIG["FIVEM_KICK_MESSAGE"] = DEFAULT_KICK_MESSAGE
                save_fivem_config()
            # Unveränderte alte Standard-Ban-Nachricht auf die Variante mit
            # [Zeit]/[Restzeit] anheben (angepasste Nachrichten bleiben unangetastet).
            if FIVEM_CONFIG.get("FIVEM_BANLIST_MESSAGE") == OLD_DEFAULT_BAN_MESSAGE:
                FIVEM_CONFIG["FIVEM_BANLIST_MESSAGE"] = DEFAULT_BAN_MESSAGE
                save_fivem_config()
        print("FiveM-Konfiguration erfolgreich geladen.")
    except Exception as e:
        print(f"Fehler beim Laden der FiveM-Konfiguration: {e}")

def save_config():
    # Convert keys back to strings for JSON
    config_to_save = CONFIG.copy()
    if "VOTE_CHANNELS" in config_to_save:
        config_to_save["VOTE_CHANNELS"] = {str(k): v for k, v in config_to_save["VOTE_CHANNELS"].items()}
    if "ROLE_SYNC_MAPPING" in config_to_save:
        config_to_save["ROLE_SYNC_MAPPING"] = {str(k): v for k, v in config_to_save["ROLE_SYNC_MAPPING"].items()}
        
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config_to_save, f, indent=4, ensure_ascii=False)
        print("Discord-Konfiguration gespeichert.")
    except Exception as e:
        print(f"Fehler beim Speichern der Discord-Konfiguration: {e}")

def save_fivem_config():
    try:
        with open(FIVEM_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(FIVEM_CONFIG, f, indent=4, ensure_ascii=False)
        print("FiveM-Konfiguration gespeichert.")
    except Exception as e:
        print(f"Fehler beim Speichern der FiveM-Konfiguration: {e}")

# --- BANN-SYSTEM ---
# Strukturierte Bans (Grund + Ablaufzeit) liegen in einer SEPARATEN Datei, damit
# das Auto-Save der FiveM-Config sie nicht überschreibt.
BANS_FILE = os.path.join(BASE_DIR, 'fivem_bans.json')
FIVEM_BANS = []
# Identifier-Typen, über die gebannt wird (stabil; IP wird bewusst ausgelassen)
BAN_IDENTIFIER_PREFIXES = ("license:", "license2:", "steam:", "discord:", "xbl:", "live:", "fivem:")

def load_bans():
    global FIVEM_BANS
    try:
        if os.path.exists(BANS_FILE):
            with open(BANS_FILE, 'r', encoding='utf-8') as f:
                FIVEM_BANS = json.load(f)
            if not isinstance(FIVEM_BANS, list):
                FIVEM_BANS = []
            print(f"[Bans] {len(FIVEM_BANS)} aktive Bans geladen.")
    except Exception as e:
        print(f"[Bans] Fehler beim Laden: {e}")
        FIVEM_BANS = []

def save_bans():
    try:
        with open(BANS_FILE, 'w', encoding='utf-8') as f:
            json.dump(FIVEM_BANS, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"[Bans] Fehler beim Speichern: {e}")

def ban_is_active(ban):
    expires = ban.get("expires")
    return expires is None or expires > time.time()

def prune_expired_bans():
    """Entfernt abgelaufene Bans und speichert bei Änderung."""
    global FIVEM_BANS
    before = len(FIVEM_BANS)
    FIVEM_BANS = [b for b in FIVEM_BANS if ban_is_active(b)]
    if len(FIVEM_BANS) != before:
        save_bans()

def format_duration(seconds):
    """Wandelt eine Dauer in Sekunden in einen lesbaren deutschen Text um
    (z.B. '2 Tage 3 Stunden'). <= 0 gilt als abgelaufen."""
    seconds = int(seconds)
    if seconds <= 0:
        return "abgelaufen"
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days} Tag{'e' if days != 1 else ''}")
    if hours:
        parts.append(f"{hours} Stunde{'n' if hours != 1 else ''}")
    if minutes:
        parts.append(f"{minutes} Minute{'n' if minutes != 1 else ''}")
    if secs and not parts:  # Sekunden nur zeigen, wenn die Dauer unter 1 Minute liegt
        parts.append(f"{secs} Sekunde{'n' if secs != 1 else ''}")
    return " ".join(parts)

def format_reason_message(template, reason, ban=None):
    """Ersetzt im Nachrichten-Template die Platzhalter:
      [Grund]    -> Bann-Grund
      [Zeit]     -> ursprüngliche Bann-Dauer (created..expires)
      [Restzeit] -> verbleibende Bann-Dauer (jetzt..expires)
    Ohne Ban-Kontext (z.B. Kick oder permanente Banlist) gelten die Zeiten als
    'permanent'."""
    reason = (reason or "").strip() or "Kein Grund angegeben"
    template = template or ""
    for ph in ("[Grund]", "[grund]", "[GRUND]", "[reason]", "[Reason]"):
        template = template.replace(ph, reason)

    original_txt = remaining_txt = "permanent"
    if ban is not None:
        expires = ban.get("expires")
        if expires is not None:
            created = ban.get("created")
            # Restzeit aufrunden (ceil), damit ein frisch verhängter Bann bei
            # "Verbleibend" die volle Dauer zeigt (statt z.B. 2T 23Std 59Min).
            remaining_secs = math.ceil(expires - time.time())
            original_txt = format_duration(expires - created) if created is not None \
                else format_duration(remaining_secs)
            remaining_txt = format_duration(remaining_secs)
    for ph in ("[Zeit]", "[zeit]", "[ZEIT]"):
        template = template.replace(ph, original_txt)
    for ph in ("[Restzeit]", "[restzeit]", "[RESTZEIT]", "[RestZeit]"):
        template = template.replace(ph, remaining_txt)
    return template

def filter_ban_identifiers(identifiers):
    return [i for i in (identifiers or []) if isinstance(i, str) and i.startswith(BAN_IDENTIFIER_PREFIXES)]

# Load config initially
load_config()
load_fivem_config()
load_bans()

# --- ADMIN SYSTEM ---
ADMIN_CONFIG_FILE = os.path.join(BASE_DIR, 'admin_config.json')
ADMIN_CONFIG = {}
SESSIONS = {}
SESSION_TTL = 24 * 3600  # Sessions laufen nach 24h ab

def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
    return f"sha256${salt}${digest}"

def verify_password(stored, password):
    if isinstance(stored, str) and stored.startswith("sha256$"):
        try:
            _, salt, digest = stored.split("$", 2)
        except ValueError:
            return False
        return hashlib.sha256((salt + password).encode('utf-8')).hexdigest() == digest
    # Legacy: Klartext-Passwort (wird beim Laden migriert)
    return stored == password

def has_permission(username, *perms):
    user_perms = ADMIN_CONFIG.get(username, {}).get("permissions", [])
    if "all" in user_perms:
        return True
    return any(p in user_perms for p in perms)

def load_admin_config():
    global ADMIN_CONFIG
    try:
        if not os.path.exists(ADMIN_CONFIG_FILE):
             ADMIN_CONFIG = {
                 "Batlax": {
                     "password": "12107tIm___",
                     "permissions": ["all"]
                 }
             }
             save_admin_config()
        else:
            with open(ADMIN_CONFIG_FILE, 'r', encoding='utf-8') as f:
                ADMIN_CONFIG = json.load(f)

        # Klartext-Passwörter zu gesalzenen Hashes migrieren
        changed = False
        for user_data in ADMIN_CONFIG.values():
            pw = user_data.get("password", "")
            if pw and not pw.startswith("sha256$"):
                user_data["password"] = hash_password(pw)
                changed = True

            # Alte Sammelberechtigung "access_rcon" auf Lesen+Schreiben aufteilen
            perms = user_data.get("permissions", [])
            if isinstance(perms, list) and "access_rcon" in perms:
                perms = [p for p in perms if p != "access_rcon"]
                for new_perm in ("rcon_read", "rcon_write"):
                    if new_perm not in perms:
                        perms.append(new_perm)
                user_data["permissions"] = perms
                changed = True

        if changed:
            save_admin_config()
            print("Admin-Konfiguration migriert (Passwörter/Berechtigungen).")

        print("Admin-Konfiguration geladen.")
    except Exception as e:
        print(f"Fehler Admin-Config: {e}")

def save_admin_config():
    try:
        with open(ADMIN_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(ADMIN_CONFIG, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Fehler Speichern Admin-Config: {e}")

load_admin_config()

# --- WEB SERVER (API & ADMIN PANEL) ---
# --- HELPER FUNCTIONS FOR JSON SAFETY ---
MAX_SAFE_INTEGER = 9007199254740991

def serialize_config(data):
    """Recursively converts large integers to strings for JSON safety."""
    if isinstance(data, dict):
        return {k: serialize_config(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [serialize_config(v) for v in data]
    elif isinstance(data, int):
        if data > MAX_SAFE_INTEGER or data < -MAX_SAFE_INTEGER:
            return str(data)
    return data

def deserialize_config(data):
    """Recursively converts ID-like strings back to integers."""
    if isinstance(data, dict):
        return {k: deserialize_config(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [deserialize_config(v) for v in data]
    elif isinstance(data, str):
        # Check if string looks like a large integer (snowflake or color)
        # We only convert if it's all digits and "large enough" or strictly an ID field context
        # But for generic config, simpler: if it parses as int and was likely an ID, convert?
        # Better strategy: Try parse int, if it round-trips to same string, keep as int?
        # No, "WEB_PORT" is int 8080. JS sends 8080 as number.
        # IDs sent as strings "123".
        if data.isdigit():
             # Heuristic: Discord IDs are usually len 17-19
             if len(data) >= 17:
                 return int(data)
    return data

async def handle_config_get(request):
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)

    config_response = serialize_config(CONFIG)
    # Bot-Token niemals an den Browser senden (weder Klartext noch verschlüsselt).
    # Das Feld bleibt leer; leer lassen = bestehenden Token behalten.
    config_response["TOKEN"] = ""
    return web.json_response(config_response)

async def handle_config_post(request):
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_general", "manage_channels",
                          "manage_roles", "manage_tickets", "manage_reactions"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        data = await request.json()
        new_config = deserialize_config(data)

        global CONFIG

        # Check if Ticket Channel changed
        old_ticket_channel_id = CONFIG.get("TICKET_CHANNEL_ID")
        new_ticket_channel_id = new_config.get("TICKET_CHANNEL_ID")

        # Token-Handling: leer = bestehenden behalten; neuer Klartext-Token wird
        # vor dem Speichern verschlüsselt, damit nie Klartext in config.json landet
        incoming_token = new_config.get("TOKEN")
        if not incoming_token:
            new_config.pop("TOKEN", None)
        elif not is_token_encrypted(incoming_token):
            new_config["TOKEN"] = encrypt_token(incoming_token)
        # Überbleibsel des Login-Formulars nicht in die Config übernehmen
        new_config.pop("username", None)
        new_config.pop("password", None)

        # Merge safely
        for key, value in new_config.items():
            CONFIG[key] = value

        normalize_config_types()
        save_config()

        # Ticket-Embed im neuen Kanal sicherstellen, wenn der Kanal geändert wurde
        if new_ticket_channel_id and (str(new_ticket_channel_id) != str(old_ticket_channel_id)):
            print(f"Ticket Channel changed to {new_ticket_channel_id}. Sending embed...")

            channel = bot.get_channel(int(new_ticket_channel_id))
            if channel:
                # Alte Bot-Nachrichten im neuen Kanal aufräumen (sauberer Start)
                try:
                    def is_me(m): return m.author == bot.user
                    await channel.purge(limit=10, check=is_me)
                except: pass

            # Nutzt dieselbe Embed/View-Logik wie beim Bot-Start (inkl. Duplikat-Check)
            await check_and_send_ticket_message()

        return web.json_response({"status": "ok", "message": "Configuration updated"})
    except Exception as e:
        print(f"Error saving config: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)

async def handle_fivem_config_get(request):
    """Returns the separate FiveM configuration."""
    if not await check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    return web.json_response(FIVEM_CONFIG)

async def handle_fivem_config_post(request):
    """Updates the separate FiveM configuration."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_fivem_settings"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        data = await request.json()
        global FIVEM_CONFIG
        
        # Merge or Replace? Using merge to be safe, though replace is fine if full config sent.
        # Front-end sends mixed config usually, but we will separate it in JS.
        # Actually plan said JS separates. So we expect only FiveM keys here.
        
        # Basic merge
        for key, value in data.items():
            FIVEM_CONFIG[key] = value
            
        save_fivem_config()
        return web.json_response({"status": "ok", "message": "FiveM Configuration updated"})
    except Exception as e:
        print(f"Error saving FiveM config: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)

def check_fivem_key(request):
    """Prüft den geteilten API-Key, den die FiveM-Resource (server.lua) mitsendet.
    Ohne konfigurierten Key bleibt die Schnittstelle offen (nicht empfohlen)."""
    expected = FIVEM_CONFIG.get("FIVEM_API_KEY") or CONFIG.get("FIVEM_API_KEY")
    if not expected:
        return True
    return request.headers.get("X-Api-Key") == expected

async def handle_fivem_validate_post(request):
    """Checks if a player is allowed to join based on current config (Banlist/Whitelist)."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        name = data.get('name', 'Unknown')
        identifiers = data.get('identifiers', [])

        ban_template = FIVEM_CONFIG.get("FIVEM_BANLIST_MESSAGE", "Du bist gebannt.")

        # 1a. Strukturierte Bans (Grund + Ablaufzeit) - werden IMMER durchgesetzt
        prune_expired_bans()
        id_set = set(identifiers)
        for ban in FIVEM_BANS:
            if not ban_is_active(ban):
                continue
            if id_set.intersection(ban.get("identifiers", [])):
                return web.json_response({
                    "allowed": False,
                    "reason": format_reason_message(ban_template, ban.get("reason"), ban)
                })

        # 1b. Manuelle Banlist (einfache Identifier, nur bei aktivierter Banlist)
        if FIVEM_CONFIG.get("FIVEM_BANLIST_ENABLED"):
            banlist = FIVEM_CONFIG.get("FIVEM_BANLIST", [])
            for identifier in identifiers:
                if identifier in banlist:
                    return web.json_response({
                        "allowed": False,
                        "reason": format_reason_message(ban_template, "Permanenter Bann")
                    })

        # 2. Whitelist Check
        if FIVEM_CONFIG.get("FIVEM_WHITELIST_ENABLED"):
            allowed = False
            
            # A) Manual Whitelist
            whitelist = FIVEM_CONFIG.get("FIVEM_WHITELIST", [])
            for identifier in identifiers:
                if identifier in whitelist:
                    allowed = True
                    break
            
            # B) Discord Role Whitelist (if not already allowed)
            if not allowed and FIVEM_CONFIG.get("FIVEM_WHITELIST_ROLE_ENABLED"):
                role_id = FIVEM_CONFIG.get("FIVEM_WHITELIST_ROLE_ID")
                guild_id = CONFIG.get("GUILD_ID")
                
                if role_id and guild_id:
                    # Find 'discord:xxx' identifier
                    discord_id = None
                    for identifier in identifiers:
                        if identifier.startswith('discord:'):
                            discord_id = identifier.replace('discord:', '')
                            break
                    
                    if discord_id:
                        guild = bot.get_guild(int(guild_id))
                        # If guild not cached, try fetch?
                        if not guild:
                             try: guild = await bot.fetch_guild(int(guild_id))
                             except: pass
                        
                        if guild:
                            member = guild.get_member(int(discord_id))
                            if not member:
                                # Try fetch member (uncached)
                                try: member = await guild.fetch_member(int(discord_id))
                                except: pass
                            
                            if member:
                                role = guild.get_role(int(role_id))
                                if role and role in member.roles:
                                    allowed = True
            
            if not allowed:
                return web.json_response({
                    "allowed": False,
                    "reason": FIVEM_CONFIG.get("FIVEM_WHITELIST_MESSAGE", "Du bist nicht auf der Whitelist.")
                })

        # Default Allow
        return web.json_response({"allowed": True})

    except Exception as e:
        print(f"Validation Error: {e}")
        # Fail safe? Allow or Deny? Deny for security if whitelist enabled. 
        # But if error implies internal error, maybe allow if whitelist disabled?
        # Safest is to return error and let script decide (usually deny if script fails)
        return web.json_response({"error": str(e)}, status=500)

# --- FIVEM STATUS STORAGE ---
FIVEM_STATUS = {
    "online": False,
    "players": [],
    "count": 0,
    "max": 0,
    "last_update": 0
}

async def handle_fivem_status_post(request):
    """Receives status updates from FiveM server resource."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        global FIVEM_STATUS
        count = data.get("playerCount", 0)
        # print(f"FiveM Status empfangen: {count} Spieler") # Optional debug
        
        FIVEM_STATUS = {
            "online": True,
            "players": data.get("players", []),
            "count": count,
            "max": data.get("maxPlayers", 0),
            "last_update": asyncio.get_event_loop().time()
        }
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_fivem_status_get(request):
    """Returns current FiveM status to frontend."""
    if not await check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)

    # Check if data is stale (> 30 seconds old)
    is_stale = (asyncio.get_event_loop().time() - FIVEM_STATUS["last_update"]) > 30

    response = FIVEM_STATUS.copy()
    if is_stale:
        response["online"] = False

    return web.json_response(response)

# --- JOBS STORAGE ---
JOBS_DATA = []

async def handle_jobs_post(request):
    """Receives the list of all server jobs (incl. grades) from the FiveM resource."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        if isinstance(data, list):
            global JOBS_DATA
            JOBS_DATA = data
            print(f"[Jobs] {len(JOBS_DATA)} Jobs vom Server empfangen.")
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_jobs_get(request):
    """Returns the job list (for the player editor dropdowns)."""
    if not await check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    return web.json_response(JOBS_DATA)

# --- COMMAND QUEUE & CONSOLE LOG ---
COMMAND_QUEUE = []
CONSOLE_LINES = deque(maxlen=1000)
CONSOLE_COUNTER = 0

def append_console_line(message, channel=""):
    global CONSOLE_COUNTER
    CONSOLE_COUNTER += 1
    CONSOLE_LINES.append({
        "id": CONSOLE_COUNTER,
        "channel": channel,
        "message": message
    })

async def handle_fivem_command_post(request):
    current_user = await check_auth(request)
    if not current_user: return web.json_response({"error": "Unauthorized"}, status=401)

    # Befehle senden erfordert Schreibrecht für die Konsole
    if not has_permission(current_user, "rcon_write"):
         return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        data = await request.json()
        cmd = data.get('command')
        if cmd:
            COMMAND_QUEUE.append(cmd)
            append_console_line(f"[RCON] {current_user}: {cmd}", "rcon")
            print(f"[RCON] Befehl eingereiht von {current_user}: {cmd}")
            return web.json_response({"status": "queued"})
        return web.json_response({"error": "No command"}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# --- PLAYER ACTIONS (Spieler-Editor im Panel) ---
PLAYER_ACTION_QUEUE = []
VALID_PLAYER_ACTIONS = {"set_name", "set_job", "set_cash", "set_bank",
                        "add_item", "remove_item", "set_item"}
MODERATION_ACTIONS = {"kick", "ban"}

def get_player_identifiers_by_id(server_id):
    """Sucht die Identifier eines aktuell online Spielers im letzten Status-Payload."""
    try:
        for p in FIVEM_STATUS.get("players", []):
            if p.get("id") == server_id:
                return p.get("identifiers", [])
    except Exception:
        pass
    return []

def get_player_name_by_id(server_id):
    for p in FIVEM_STATUS.get("players", []):
        if p.get("id") == server_id:
            return p.get("name") or p.get("rp_name") or "Unbekannt"
    return "Unbekannt"

async def handle_player_action_post(request):
    """Queues a player action (edit/kick/ban) for the game server."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_players"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        data = await request.json()
        action = data.get("action")
        if action not in VALID_PLAYER_ACTIONS and action not in MODERATION_ACTIONS:
            return web.json_response({"error": "Unbekannte Aktion"}, status=400)

        # Online-Spieler werden über die Server-ID angesprochen, Offline-Spieler
        # nur über den (DB-)Identifier - mindestens eins von beidem muss da sein.
        target_id = data.get("id")
        identifier = data.get("identifier")
        if target_id is not None:
            try:
                target_id = int(target_id)
            except (TypeError, ValueError):
                return web.json_response({"error": "Ungültige Spieler-ID"}, status=400)
        if target_id is None and not identifier:
            return web.json_response({"error": "Spieler-ID oder Identifier benötigt"}, status=400)

        params = data.get("params")
        if not isinstance(params, dict):
            params = {}

        # --- Moderation: Kick / Ban ---
        if action == "kick":
            reason = str(params.get("reason") or "").strip()
            message = format_reason_message(FIVEM_CONFIG.get("FIVEM_KICK_MESSAGE", DEFAULT_KICK_MESSAGE), reason)
            PLAYER_ACTION_QUEUE.append({"action": "kick", "id": target_id, "identifier": identifier,
                                        "params": {"message": message}})
            name = get_player_name_by_id(target_id)
            append_console_line(f"[Panel] {current_user}: KICK -> {name} (ID {target_id}) | Grund: {reason or '-'}", "rcon")
            print(f"[Panel] Kick eingereiht von {current_user}: ID {target_id} | Grund: {reason}")
            return web.json_response({"status": "queued"})

        if action == "ban":
            reason = str(params.get("reason") or "").strip()
            try:
                duration = int(params.get("duration") or 0)  # Sekunden, 0 = permanent
            except (TypeError, ValueError):
                duration = 0
            identifiers = filter_ban_identifiers(params.get("identifiers") or get_player_identifiers_by_id(target_id))
            if not identifiers:
                return web.json_response({"error": "Keine bann-fähigen Identifier für diesen Spieler gefunden"}, status=400)

            name = params.get("name") or get_player_name_by_id(target_id)
            ban_entry = {
                "id": uuid.uuid4().hex,
                "identifiers": identifiers,
                "name": name,
                "reason": reason,
                "by": current_user,
                "created": int(time.time()),
                "expires": (int(time.time()) + duration) if duration > 0 else None
            }
            FIVEM_BANS.append(ban_entry)
            save_bans()

            # Spieler sofort vom Server werfen (mit Ban-Nachricht inkl. Grund/Zeit)
            message = format_reason_message(FIVEM_CONFIG.get("FIVEM_BANLIST_MESSAGE", DEFAULT_BAN_MESSAGE), reason, ban_entry)
            if target_id is not None:
                PLAYER_ACTION_QUEUE.append({"action": "kick", "id": target_id, "identifier": identifier,
                                            "params": {"message": message}})

            dauer_txt = "permanent" if duration <= 0 else f"{duration}s"
            append_console_line(f"[Panel] {current_user}: BAN ({dauer_txt}) -> {name} | Grund: {reason or '-'}", "rcon")
            print(f"[Panel] Ban eingereiht von {current_user}: {name} ({dauer_txt}) | Grund: {reason}")
            return web.json_response({"status": "queued", "ban_id": ban_entry["id"]})

        # --- Normale Spieler-Edits ---
        entry = {
            "action": action,
            "id": target_id,
            "identifier": identifier,
            "params": params
        }
        PLAYER_ACTION_QUEUE.append(entry)
        target_label = target_id if target_id is not None else identifier
        append_console_line(f"[Panel] {current_user}: {action} -> Spieler {target_label} {json.dumps(params, ensure_ascii=False)}", "rcon")
        print(f"[Panel] Spieler-Aktion eingereiht von {current_user}: {action} -> {target_label} {params}")
        return web.json_response({"status": "queued"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# --- BANS: Auflisten & Entbannen (für die Bann-Verwaltung im Panel) ---
async def handle_bans_get(request):
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_players", "manage_fivem_settings"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    prune_expired_bans()
    return web.json_response(FIVEM_BANS)

async def handle_unban_post(request):
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_players", "manage_fivem_settings"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    try:
        data = await request.json()
        ban_id = data.get("id")
        global FIVEM_BANS
        before = len(FIVEM_BANS)
        removed = [b for b in FIVEM_BANS if b.get("id") == ban_id]
        FIVEM_BANS = [b for b in FIVEM_BANS if b.get("id") != ban_id]
        if len(FIVEM_BANS) == before:
            return web.json_response({"error": "Ban nicht gefunden"}, status=404)
        save_bans()
        name = removed[0].get("name", "?") if removed else "?"
        append_console_line(f"[Panel] {current_user}: ENTBANNT -> {name}", "rcon")
        print(f"[Panel] Entbannt von {current_user}: {name}")
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# --- OFFLINE PLAYER DETAILS (DB-Abfrage über den Game-Server) ---
DETAIL_REQUEST_QUEUE = []
PLAYER_DETAILS = {}  # request_id -> {"data": ..., "ts": ...}

async def handle_player_details_request(request):
    """Panel fordert DB-Details (Geld, Inventar, Job) eines Offline-Spielers an."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "view_players"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        data = await request.json()
        identifier = data.get("identifier")
        if not identifier or not isinstance(identifier, str):
            return web.json_response({"error": "Identifier fehlt"}, status=400)

        request_id = uuid.uuid4().hex
        DETAIL_REQUEST_QUEUE.append({"request_id": request_id, "identifier": identifier})
        return web.json_response({"request_id": request_id})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_player_details_post(request):
    """Game-Server liefert das Ergebnis einer Detail-Anfrage zurück."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        request_id = data.get("request_id")
        if request_id:
            PLAYER_DETAILS[request_id] = {"data": data.get("data"), "ts": time.time()}
            # Nicht abgeholte Ergebnisse nach 2 Minuten verwerfen
            cutoff = time.time() - 120
            for stale in [k for k, v in PLAYER_DETAILS.items() if v["ts"] < cutoff]:
                del PLAYER_DETAILS[stale]
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_player_details_get(request):
    """Panel pollt das Ergebnis einer Detail-Anfrage (einmalige Abholung)."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "view_players"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    request_id = request.query.get("id")
    entry = PLAYER_DETAILS.pop(request_id, None) if request_id else None
    if entry is not None:
        return web.json_response({"status": "ready", "data": entry["data"]})
    return web.json_response({"status": "pending"})

# --- JOB-MITARBEITER (DB-Abfrage über den Game-Server) ---
JOB_EMPLOYEE_REQUEST_QUEUE = []
JOB_EMPLOYEES = {}  # request_id -> {"data": ..., "ts": ...}

async def handle_job_employees_request(request):
    """Panel fordert die Mitarbeiterliste eines Jobs an."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    try:
        data = await request.json()
        job = data.get("job")
        if not job or not isinstance(job, str):
            return web.json_response({"error": "Job fehlt"}, status=400)
        request_id = uuid.uuid4().hex
        JOB_EMPLOYEE_REQUEST_QUEUE.append({"request_id": request_id, "job": job})
        return web.json_response({"request_id": request_id})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_job_employees_post(request):
    """Game-Server liefert die Mitarbeiterliste zurück."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        request_id = data.get("request_id")
        if request_id:
            JOB_EMPLOYEES[request_id] = {"data": data.get("data"), "ts": time.time()}
            cutoff = time.time() - 120
            for stale in [k for k, v in JOB_EMPLOYEES.items() if v["ts"] < cutoff]:
                del JOB_EMPLOYEES[stale]
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_job_employees_get(request):
    """Panel pollt die Mitarbeiterliste (einmalige Abholung)."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    request_id = request.query.get("id")
    entry = JOB_EMPLOYEES.pop(request_id, None) if request_id else None
    if entry is not None:
        return web.json_response({"status": "ready", "data": entry["data"]})
    return web.json_response({"status": "pending"})

async def handle_job_action_post(request):
    """Einstellen / Feuern / Auf- & Abstufen eines Mitarbeiters (setzt Job+Grade)."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    try:
        data = await request.json()
        action = data.get("action")  # hire | fire | promote | demote (nur fürs Logging)
        job = data.get("job")
        grade = data.get("grade", 0)
        if not job or not isinstance(job, str):
            return web.json_response({"error": "Job fehlt"}, status=400)
        try:
            grade = int(grade)
        except (TypeError, ValueError):
            grade = 0

        target_id = data.get("id")
        identifier = data.get("identifier")
        if target_id is not None:
            try:
                target_id = int(target_id)
            except (TypeError, ValueError):
                target_id = None
        if target_id is None and not identifier:
            return web.json_response({"error": "Spieler-ID oder Identifier benötigt"}, status=400)

        # Nutzt die bestehende set_job-Aktion (online via ESX, offline via DB)
        PLAYER_ACTION_QUEUE.append({
            "action": "set_job",
            "id": target_id,
            "identifier": identifier,
            "params": {"job": job, "grade": grade}
        })
        target_label = target_id if target_id is not None else identifier
        append_console_line(f"[Panel] {current_user}: JOB {action or 'set'} -> Spieler {target_label}: {job} (Grade {grade})", "rcon")
        print(f"[Panel] Job-Aktion von {current_user}: {action} -> {target_label} = {job}/{grade}")
        return web.json_response({"status": "queued"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# --- JOB-CREATOR: Daten, Speichern/Löschen, Koordinaten-Erfassung ---
RAZE_JOB_DATA = {}      # job_name -> extra data (locations, f5, civ_access, ...)
JOB_DB_QUEUE = []       # Schreib-Operationen für den Game-Server (save/delete)
LAST_JOB_LOCATION = {"coords": None, "ts": 0}

async def handle_job_data_get(request):
    """Panel holt die Zusatz-Job-Daten (Locations etc.) aus raze_job_data."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    return web.json_response(RAZE_JOB_DATA)

async def handle_job_data_post(request):
    """Game-Server synct den Inhalt von raze_job_data ans Panel."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        global RAZE_JOB_DATA
        if isinstance(data, dict):
            RAZE_JOB_DATA = data
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

def _valid_job_name(name):
    return isinstance(name, str) and 0 < len(name) <= 50 and all(c.isalnum() or c == '_' for c in name)


def _upsert_job_in_jobs_data(name, label, grades):
    """Aktualisiert die ESX-Basis-Jobliste (JOBS_DATA) optimistisch, damit
    /api/fivem/jobs sofort die gespeicherten Grades/Label liefert – ohne auf den
    Game-Server-Roundtrip (Poll alle 2s + asynchrones ESX.RefreshJobs + 5-Min-Sync)
    zu warten. Sonst zeigt der Job-Editor nach dem Speichern beim erneuten Öffnen
    noch die alten Werte (erst ein manueller Seiten-Reload würde es korrigieren)."""
    entry = {"name": name, "label": label, "grades": grades}
    for i, j in enumerate(JOBS_DATA):
        if isinstance(j, dict) and j.get("name") == name:
            JOBS_DATA[i] = entry
            break
    else:
        JOBS_DATA.append(entry)
    JOBS_DATA.sort(key=lambda j: str((j.get("label") or j.get("name")) if isinstance(j, dict) else "").lower())

async def handle_job_save_post(request):
    """Erstellt/aktualisiert einen Job (ESX-Basis jobs/job_grades + raze_job_data)."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    try:
        data = await request.json()
        name = (data.get("name") or "").strip().lower()
        if not _valid_job_name(name):
            return web.json_response({"error": "Ungültiger Job-Name (nur a-z, 0-9, _)"}, status=400)
        if name == "unemployed":
            return web.json_response({"error": "'unemployed' kann nicht bearbeitet werden"}, status=400)
        label = (data.get("label") or name).strip()

        grades = []
        for g in (data.get("grades") or []):
            try:
                grades.append({
                    "grade": int(g.get("grade")),
                    "name": str(g.get("name") or g.get("label") or "grade"),
                    "label": str(g.get("label") or g.get("name") or "Grade"),
                    "salary": max(0, int(g.get("salary") or 0))
                })
            except (TypeError, ValueError):
                continue
        if not grades:
            grades = [{"grade": 0, "name": "recruit", "label": "Mitarbeiter", "salary": 0}]
        grades.sort(key=lambda x: x["grade"])

        extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}

        # ESX-Basis + raze_job_data über den Game-Server schreiben lassen
        JOB_DB_QUEUE.append({"op": "save", "name": name, "label": label, "grades": grades, "extra": extra})
        # Optimistisch im Panel-Cache aktualisieren (Zusatzdaten UND ESX-Basis),
        # damit ein sofortiges Wieder-Öffnen des Editors die neuen Werte zeigt.
        RAZE_JOB_DATA[name] = extra
        _upsert_job_in_jobs_data(name, label, grades)
        append_console_line(f"[Panel] {current_user}: JOB-SAVE -> {name} ({len(grades)} Grades)", "rcon")
        print(f"[Panel] Job gespeichert von {current_user}: {name}")
        return web.json_response({"status": "queued"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_job_delete_post(request):
    """Löscht einen Job (jobs/job_grades + raze_job_data)."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    try:
        data = await request.json()
        name = (data.get("name") or "").strip().lower()
        if not _valid_job_name(name) or name == "unemployed":
            return web.json_response({"error": "Ungültiger Job"}, status=400)
        JOB_DB_QUEUE.append({"op": "delete", "name": name})
        RAZE_JOB_DATA.pop(name, None)
        # Optimistisch auch aus der ESX-Basis-Jobliste entfernen
        JOBS_DATA[:] = [j for j in JOBS_DATA if not (isinstance(j, dict) and j.get("name") == name)]
        append_console_line(f"[Panel] {current_user}: JOB-DELETE -> {name}", "rcon")
        print(f"[Panel] Job gelöscht von {current_user}: {name}")
        return web.json_response({"status": "queued"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_job_location_post(request):
    """Game-Server meldet eine im Spiel erfasste Position (/setjobloc)."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        global LAST_JOB_LOCATION
        LAST_JOB_LOCATION = {"coords": data.get("coords"), "label": data.get("label"), "ts": time.time()}
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_job_location_get(request):
    """Panel holt die zuletzt im Spiel erfasste Position."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "manage_jobs"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)
    # Position nur als "frisch" liefern, wenn < 60s alt
    fresh = (time.time() - LAST_JOB_LOCATION.get("ts", 0)) < 60
    return web.json_response({"coords": LAST_JOB_LOCATION.get("coords") if fresh else None,
                              "fresh": fresh})

async def handle_fivem_commands_get(request):
    # Called by FiveM Server script
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)

    response = {"commands": [], "actions": [], "detail_requests": [], "job_employee_requests": [], "job_db_ops": []}
    if COMMAND_QUEUE:
        response["commands"] = list(COMMAND_QUEUE)
        COMMAND_QUEUE.clear()
    if PLAYER_ACTION_QUEUE:
        response["actions"] = list(PLAYER_ACTION_QUEUE)
        PLAYER_ACTION_QUEUE.clear()
    if DETAIL_REQUEST_QUEUE:
        response["detail_requests"] = list(DETAIL_REQUEST_QUEUE)
        DETAIL_REQUEST_QUEUE.clear()
    if JOB_EMPLOYEE_REQUEST_QUEUE:
        response["job_employee_requests"] = list(JOB_EMPLOYEE_REQUEST_QUEUE)
        JOB_EMPLOYEE_REQUEST_QUEUE.clear()
    if JOB_DB_QUEUE:
        response["job_db_ops"] = list(JOB_DB_QUEUE)
        JOB_DB_QUEUE.clear()
    return web.json_response(response)

async def handle_console_post(request):
    """Receives captured console output lines from the FiveM resource."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        for line in data.get("lines", []):
            if isinstance(line, dict):
                message = line.get("message", "")
                channel = line.get("channel", "")
            else:
                message = str(line)
                channel = ""
            if message:
                append_console_line(message, channel)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_console_get(request):
    """Returns buffered console lines (incremental via ?after=<id>) to the panel."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    # Konsole lesen erfordert Lese- oder Schreibrecht
    if not has_permission(current_user, "rcon_read", "rcon_write"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        after = int(request.query.get("after", 0))
    except ValueError:
        after = 0
    # Nach einem Bot-Neustart beginnt der Zähler neu -> Client-Cursor zurücksetzen
    if after > CONSOLE_COUNTER:
        after = 0

    lines = [l for l in CONSOLE_LINES if l["id"] > after][:500]
    last_id = lines[-1]["id"] if lines else after
    return web.json_response({"lines": lines, "last_id": last_id})

# --- ALL PLAYERS STORAGE ---
ALL_PLAYERS_DATA = []

ALL_PLAYERS_FILE = os.path.join(BASE_DIR, "all_players_cache.json")

def load_all_players_cache():
    global ALL_PLAYERS_DATA
    if os.path.exists(ALL_PLAYERS_FILE):
        try:
            with open(ALL_PLAYERS_FILE, 'r', encoding='utf-8') as f:
                ALL_PLAYERS_DATA = json.load(f)
            print(f"[Cache] {len(ALL_PLAYERS_DATA)} Spieler aus Cache geladen.")
        except Exception as e:
            print(f"[Cache] Fehler beim Laden: {e}")

# Try to load on startup
load_all_players_cache()

async def handle_all_players_post(request):
    """Receives all players history from FiveM server."""
    if not check_fivem_key(request):
        return web.json_response({"error": "Invalid API key"}, status=401)
    try:
        data = await request.json()
        global ALL_PLAYERS_DATA
        ALL_PLAYERS_DATA = data
        
        # Save to cache
        try:
             with open(ALL_PLAYERS_FILE, 'w', encoding='utf-8') as f:
                json.dump(ALL_PLAYERS_DATA, f)
        except Exception as e:
            print(f"[Cache] Fehler beim Speichern: {e}")
            
        print(f"All Players Data empfangen: {len(ALL_PLAYERS_DATA)} Einträge")
        return web.json_response({"status": "ok"})
    except Exception as e:
        print(f"Fehler in handle_all_players_post: {e}")
        return web.json_response({"error": str(e)}, status=500)

async def handle_all_players_get(request):
    """Returns all players history to frontend."""
    current_user = await check_auth(request)
    if not current_user:
        return web.json_response({"error": "Unauthorized"}, status=401)
    if not has_permission(current_user, "view_players"):
        return web.json_response({"error": "Keine Berechtigung"}, status=403)

    # Reload from cache if empty (just in case)
    if not ALL_PLAYERS_DATA:
        load_all_players_cache()
    return web.json_response(ALL_PLAYERS_DATA)

async def handle_data_get(request):
    """Returns dynamic data from the Discord guild (Channels, Roles, Categories)."""
    if not await check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)

    server_id = CONFIG.get("GUILD_ID")
    if not server_id:
        return web.json_response({"error": "GUILD_ID not configured"}, status=400)
    
    guild = bot.get_guild(server_id)
    if not guild:
         # Try fetching if not in cache (rare case for bot)
        try:
            guild = await bot.fetch_guild(server_id)
        except:
             return web.json_response({"error": "Guild not found"}, status=404)
             
    data = {
        "channels": [{"id": str(c.id), "name": c.name, "type": str(c.type)} for c in guild.channels],
        "roles": [{"id": str(r.id), "name": r.name, "color": str(r.color)} for r in guild.roles],
        "categories": [{"id": str(c.id), "name": c.name} for c in guild.categories],
        "emojis": [{"id": str(e.id), "name": e.name, "url": str(e.url)} for e in guild.emojis]
    }
    
    return web.json_response(data)

# --- AUTH & ADMIN HANDLERS ---
async def handle_login(request):
    try:
        data = await request.json()
        username = data.get("username")
        password = data.get("password")

        if username in ADMIN_CONFIG and password and verify_password(ADMIN_CONFIG[username]["password"], password):
            token = str(uuid.uuid4())
            SESSIONS[token] = {"user": username, "expires": time.time() + SESSION_TTL}
            return web.json_response({
                "token": token,
                "username": username,
                "permissions": ADMIN_CONFIG[username].get("permissions", [])
            })
        return web.json_response({"error": "Ungültige Login-Daten"}, status=401)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def check_auth(request):
    token = request.headers.get("Authorization")
    if not token:
        return None
    session = SESSIONS.get(token)
    if not session:
        return None
    if time.time() > session["expires"]:
        del SESSIONS[token]
        return None
    return session["user"]

async def handle_admins_get(request):
    if not await check_auth(request): return web.json_response({"error": "Unauthorized"}, status=401)
    
    safe_list = []
    for user, data in ADMIN_CONFIG.items():
        safe_list.append({
            "username": user,
            "permissions": data.get("permissions", [])
        })
    return web.json_response(safe_list)

async def handle_admins_post(request):
    current_user = await check_auth(request)
    if not current_user: return web.json_response({"error": "Unauthorized"}, status=401)

    if not has_permission(current_user, "manage_admins"):
         return web.json_response({"error": "Keine Berechtigung"}, status=403)

    try:
        data = await request.json()
        username = data.get("username")
        password = data.get("password")
        permissions = data.get("permissions", [])

        if not username:
             return web.json_response({"error": "Username fehlt"}, status=400)

        # If updating existing user, keep password if not provided
        if username in ADMIN_CONFIG and not password:
            password_hash = ADMIN_CONFIG[username]["password"]
        elif not password:
            return web.json_response({"error": "Passwort fehlt"}, status=400)
        else:
            password_hash = hash_password(password)

        ADMIN_CONFIG[username] = {
            "password": password_hash,
            "permissions": permissions
        }
        save_admin_config()
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_admins_delete(request):
    current_user = await check_auth(request)
    if not current_user: return web.json_response({"error": "Unauthorized"}, status=401)

    if not has_permission(current_user, "manage_admins"):
         return web.json_response({"error": "Keine Berechtigung"}, status=403)

    target = request.match_info.get('username')
    if target == current_user:
        return web.json_response({"error": "Du kannst dich nicht selbst löschen"}, status=400)
        
    if target in ADMIN_CONFIG:
        del ADMIN_CONFIG[target]
        save_admin_config()
        return web.json_response({"status": "ok"})
    return web.json_response({"error": "User nicht gefunden"}, status=404)

async def start_web_server():
    # Middleware for CORS and Logging
    @web.middleware
    async def cors_middleware(request, handler):
        # Handle Preflight
        if request.method == 'OPTIONS':
            response = web.Response(status=200)
        else:
            try:
                response = await handler(request)
            except web.HTTPException as ex:
                response = ex
            except Exception as e:
                print(f"Server Error: {e}")
                response = web.Response(status=500, text=str(e))

        # Add CORS headers
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS, DELETE, PUT'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return response

    @web.middleware
    async def logging_middleware(request, handler):
        print(f"WEB REQUEST: {request.method} {request.path}")
        return await handler(request)

    app = web.Application(middlewares=[cors_middleware, logging_middleware])
    
    # API Routes
    app.router.add_get('/api/config', handle_config_get)
    app.router.add_post('/api/config', handle_config_post)
    app.router.add_get('/api/data', handle_data_get)
    
    # Static files setup moved to end to prevent route conflicts
    
    # FiveM API
    app.router.add_post('/api/fivem/status', handle_fivem_status_post)
    app.router.add_get('/api/fivem/status', handle_fivem_status_get)
    app.router.add_post('/api/fivem/allplayers', handle_all_players_post)
    app.router.add_get('/api/fivem/allplayers', handle_all_players_get)
    app.router.add_get('/api/fivem/config', handle_fivem_config_get)
    app.router.add_post('/api/fivem/config', handle_fivem_config_post)
    app.router.add_post('/api/fivem/validate', handle_fivem_validate_post)
    app.router.add_post('/api/fivem/command', handle_fivem_command_post)
    app.router.add_get('/api/fivem/commands', handle_fivem_commands_get)
    app.router.add_post('/api/fivem/console', handle_console_post)
    app.router.add_get('/api/fivem/console', handle_console_get)
    app.router.add_post('/api/fivem/jobs', handle_jobs_post)
    app.router.add_get('/api/fivem/jobs', handle_jobs_get)
    app.router.add_post('/api/fivem/player_action', handle_player_action_post)
    app.router.add_post('/api/fivem/player_details_request', handle_player_details_request)
    app.router.add_post('/api/fivem/player_details', handle_player_details_post)
    app.router.add_get('/api/fivem/player_details', handle_player_details_get)
    app.router.add_get('/api/fivem/bans', handle_bans_get)
    app.router.add_post('/api/fivem/unban', handle_unban_post)
    app.router.add_post('/api/fivem/job_employees_request', handle_job_employees_request)
    app.router.add_post('/api/fivem/job_employees', handle_job_employees_post)
    app.router.add_get('/api/fivem/job_employees', handle_job_employees_get)
    app.router.add_post('/api/fivem/job_action', handle_job_action_post)
    app.router.add_get('/api/fivem/job_data', handle_job_data_get)
    app.router.add_post('/api/fivem/job_data', handle_job_data_post)
    app.router.add_post('/api/fivem/job_save', handle_job_save_post)
    app.router.add_post('/api/fivem/job_delete', handle_job_delete_post)
    app.router.add_post('/api/fivem/job_location', handle_job_location_post)
    app.router.add_get('/api/fivem/job_location', handle_job_location_get)
    
    # Auth & Admin Routes
    app.router.add_post('/api/login', handle_login)
    app.router.add_get('/api/admins', handle_admins_get)
    app.router.add_post('/api/admins', handle_admins_post)
    app.router.add_delete('/api/admins/{username}', handle_admins_delete)

    # Static Files (Moved here so catch-all '/' doesn't block API routes)
    # Strategy 0: Flat structure (files in same dir as bot.py)
    # We serve specific files manually to avoid exposing bot.py/config.json via static handler
    path_flat = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(path_flat, "index.html")):
        print(f"Panel-Pfad: Flache Struktur erkannt ({path_flat})")
        
        async def serve_file(request, filename):
             return web.FileResponse(os.path.join(path_flat, filename))

        app.router.add_get('/', lambda r: serve_file(r, 'index.html'))
        app.router.add_get('/index.html', lambda r: serve_file(r, 'index.html'))
        app.router.add_get('/style.css', lambda r: serve_file(r, 'style.css'))
        app.router.add_get('/script.js', lambda r: serve_file(r, 'script.js'))
        
    else:
        # Strategy 1: Sibling folder (Standard dev structure)
        path_strategy_1 = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Panel Webseite")
        # Strategy 2: "Panel Webseite" in current directory (if user moved bot.py up)
        path_strategy_2 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Panel Webseite")
        # Strategy 3: "panel" folder (generic fallback)
        path_strategy_3 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "panel")
        
        panel_path = None
        if os.path.exists(path_strategy_1):
            panel_path = path_strategy_1
        elif os.path.exists(path_strategy_2):
            panel_path = path_strategy_2
        elif os.path.exists(path_strategy_3):
            panel_path = path_strategy_3
        
        if panel_path:
            # Custom Static Handler to avoid 405 Method Not Allowed issues with add_static on root
            async def static_handler(request):
                path = request.match_info.get('tail', '')
                if not path:
                    path = 'index.html'
                
                # Security: Prevent directory traversal
                safe_path = os.path.normpath(path)
                if safe_path.startswith('.') or safe_path.startswith('/'):
                     return web.Response(status=403, text="Forbidden")
                
                full_path = os.path.join(panel_path, safe_path)
                
                if os.path.exists(full_path) and os.path.isfile(full_path):
                    return web.FileResponse(full_path)
                
                # Fallback to index.html for SPA (or 404 if really missing)
                index_path = os.path.join(panel_path, 'index.html')
                if os.path.exists(index_path):
                    return web.FileResponse(index_path)
                
                return web.Response(status=404, text="File not found")

            app.router.add_get('/{tail:.*}', static_handler)
            print(f"Panel-Pfad gefunden und registriert: {panel_path}")
        else:
            print(f"WARNUNG: Panel-Dateien nicht gefunden.")
            print("Bitte stelle sicher, dass 'index.html' im selben Ordner wie der Bot liegt")

    runner = web.AppRunner(app)
    await runner.setup()
    
    # Port from Config or default 8080
    port = CONFIG.get("WEB_PORT", 8080)
    site = web.TCPSite(runner, '0.0.0.0', port)
    
    try:
        print("--- Registered Routes ---")
        for resource in app.router.resources():
            print(resource)
        print("-------------------------")
        await site.start()
        print(f"Web Server läuft auf http://0.0.0.0:{port}")
    except OSError as e:
        print(f"FEHLER: Konnte Webserver auf Port {port} nicht starten: {e}")
        print("Möglicherweise ist der Port belegt oder du hast keine Berechtigung.")

def run_web_server_only():
    """Startet nur das Web-Panel ohne Discord-Verbindung.
    Wird genutzt, wenn kein/ein ungültiger Token vorliegt, damit das Panel
    erreichbar bleibt und dort ein gültiger Token eingetragen werden kann."""
    async def runner():
        await start_web_server()
        while True:
            await asyncio.sleep(3600)
    try:
        asyncio.run(runner())
    except (KeyboardInterrupt, SystemExit):
        print("Web-Panel beendet.")

# --- VERIFIZIERUNG BUTTON KLASSE ---
class VerifyView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None) # Timeout=None macht den Button persistent

    @discord.ui.button(label="Verifizieren", style=discord.ButtonStyle.green, custom_id="verify_button_raze")
    async def verify_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        role = interaction.guild.get_role(CONFIG.get("VERIFY_ROLE_ID"))
        if role is None:
            await interaction.response.send_message("Fehler: Verifizierungs-Rolle nicht gefunden.", ephemeral=True)
            return

        if role in interaction.user.roles:
            await interaction.response.send_message("Du bist bereits verifiziert!", ephemeral=True)
        else:
            try:
                await interaction.user.add_roles(role)
                await interaction.response.send_message("Du wurdest erfolgreich verifiziert! Willkommen auf Raze Roleplay.", ephemeral=True)
            except discord.errors.Forbidden:
                await interaction.response.send_message("Fehler: Ich habe keine Berechtigung, Rollen zu vergeben.", ephemeral=True)

# --- TICKET UI ---
class TicketCloseButton(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Ticket schließen", style=discord.ButtonStyle.red, custom_id="close_ticket_button")
    async def close_ticket(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        
        # 1. Kategorie für geschlossene Tickets suchen
        closed_category = interaction.guild.get_channel(CONFIG.get("TICKET_CATEGORY_CLOSED"))
        if not closed_category:
            await interaction.followup.send("Fehler: Kategorie für geschlossene Tickets nicht gefunden.", ephemeral=True)
            return

        # 2. Berechtigungen zurücksetzen (nur Admins behalten Zugriff, aber ohne Schreibrechte)
        overwrites = {
            interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
        }
        
        # Nur die permanenten Admins behalten Lese-Zugriff, dürfen aber nicht mehr schreiben
        for admin_role_id in CONFIG.get("TICKET_PERMANENT_ADMINS", []):
            admin_role = interaction.guild.get_role(admin_role_id)
            if admin_role:
                overwrites[admin_role] = discord.PermissionOverwrite(read_messages=True, send_messages=False)

        try:
            # 3. Ticket verschieben und Berechtigungen anpassen
            await interaction.channel.edit(
                category=closed_category,
                overwrites=overwrites,
                name=f"closed-{interaction.channel.name}"
            )
            
            # 4. Button aus der aktuellen Nachricht entfernen
            await interaction.message.edit(view=None)
            
            embed = discord.Embed(
                title="Ticket geschlossen",
                description=f"Dieses Ticket wurde von {interaction.user.mention} geschlossen und archiviert.\nSchreibrechte wurden für alle entzogen.",
                color=discord.Color.greyple()
            )
            await interaction.channel.send(embed=embed)
            
            # 5. Logging
            log_channel = interaction.guild.get_channel(CONFIG.get("TICKET_LOG_CHANNEL_ID"))
            if log_channel:
                log_embed = discord.Embed(
                    title="Ticket Geschlossen",
                    description=f"**Ticket:** {interaction.channel.name}\n**Geschlossen von:** {interaction.user.mention}",
                    color=discord.Color.red(),
                    timestamp=discord.utils.utcnow()
                )
                await log_channel.send(embed=log_embed)
                
            # 6. DM an den Ersteller senden (falls möglich)
            async for message in interaction.channel.history(oldest_first=True, limit=1):
                if message.mentions:
                    creator = message.mentions[0]
                    try:
                        dm_embed = discord.Embed(
                            title="Ticket geschlossen",
                            description=f"Dein Ticket auf **Raze Roleplay** (#{interaction.channel.name}) wurde geschlossen.",
                            color=CONFIG.get("ACCENT_COLOR")
                        )
                        dm_embed.set_thumbnail(url=CONFIG.get("SERVER_LOGO_URL"))
                        await creator.send(embed=dm_embed)
                    except: pass
            
            await interaction.followup.send("Ticket wurde erfolgreich geschlossen.", ephemeral=True)
            
        except discord.errors.Forbidden:
            await interaction.followup.send("Fehler: Ich habe keine Berechtigung, das Ticket zu bearbeiten.", ephemeral=True)

class TicketSelect(discord.ui.Select):
    def __init__(self):
        ticket_types = CONFIG.get("TICKET_TYPES", {})
        options = [
            discord.SelectOption(label=data["label"], value=key, description=f"Erstelle ein Ticket für {data['label']}")
            for key, data in ticket_types.items()
        ]
        super().__init__(placeholder="Wähle einen Grund für dein Ticket...", min_values=1, max_values=1, options=options, custom_id="ticket_select")

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        ticket_type = self.values[0]
        data = CONFIG.get("TICKET_TYPES", {}).get(ticket_type)
        if not data:
            await interaction.followup.send("Fehler: Dieser Ticket-Typ existiert nicht mehr.", ephemeral=True)
            return
        
        # 1. Ticket-Limit prüfen (max 3 offene Tickets pro User)
        category_open = interaction.guild.get_channel(CONFIG.get("TICKET_CATEGORY_OPEN"))
        
        if category_open:
            user_tickets = [c for c in category_open.text_channels if c.name.endswith(f"-{interaction.user.name.lower()}")]
            if len(user_tickets) >= 3:
                await interaction.followup.send("Du hast bereits 3 offene Tickets. Bitte schließe erst ein Ticket, bevor du ein neues eröffnest.", ephemeral=True)
                return

        # 2. Kategorie für offene Tickets suchen
        if not category_open:
            await interaction.followup.send("Fehler: Ticket-Kategorie nicht gefunden.", ephemeral=True)
            return

        # 3. Berechtigungen festlegen
        overwrites = {
            interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
            interaction.user: discord.PermissionOverwrite(read_messages=True, send_messages=True, attach_files=True, embed_links=True)
        }
        
        # Team-Rollen Zugriff geben
        for role_id in data["roles"]:
            role = interaction.guild.get_role(role_id)
            if role:
                overwrites[role] = discord.PermissionOverwrite(read_messages=True, send_messages=True, attach_files=True, embed_links=True)

        # 4. Kanal erstellen
        channel_name = f"{data['prefix']}-{interaction.user.name}"
        try:
            ticket_channel = await interaction.guild.create_text_channel(
                name=channel_name,
                category=category_open,
                overwrites=overwrites
            )
            
            # 5. Willkommensnachricht im Ticket
            embed = discord.Embed(
                title="Willkommen im Raze Roleplay Ticket Support",
                description=f"Hallo {interaction.user.mention},\n\nvielen Dank für deine Anfrage! Ein Teammitglied wird sich in Kürze um dein Anliegen kümmern.\n\n**Grund:** {data['label']}\n\nBitte beschreibe dein Problem so genau wie möglich.",
                color=CONFIG.get("ACCENT_COLOR")
            )
            embed.set_thumbnail(url=CONFIG.get("SERVER_LOGO_URL"))
            embed.set_footer(text="Raze Roleplay Support System", icon_url=CONFIG.get("SERVER_LOGO_URL"))
            
            # Alle zuständigen Rollen erwähnen
            role_mentions = " ".join([f"<@&{role_id}>" for role_id in data['roles']])
            await ticket_channel.send(content=f"{interaction.user.mention} | {role_mentions}", embed=embed, view=TicketCloseButton())
            
            # 6. Bestätigungs-DM an den User
            try:
                dm_embed = discord.Embed(
                    title="Ticket erstellt",
                    description=f"Dein Ticket wurde erfolgreich erstellt: {ticket_channel.mention}\n**Grund:** {data['label']}",
                    color=CONFIG.get("ACCENT_COLOR")
                )
                dm_embed.set_thumbnail(url=CONFIG.get("SERVER_LOGO_URL"))
                await interaction.user.send(embed=dm_embed)
            except: pass

            # 7. Logging
            log_channel = interaction.guild.get_channel(CONFIG.get("TICKET_LOG_CHANNEL_ID"))
            if log_channel:
                log_embed = discord.Embed(
                    title="Ticket Erstellt",
                    description=f"**User:** {interaction.user.mention}\n**Kanal:** {ticket_channel.mention}\n**Grund:** {data['label']}",
                    color=discord.Color.green(),
                    timestamp=discord.utils.utcnow()
                )
                await log_channel.send(embed=log_embed)

            await interaction.followup.send(f"Dein Ticket wurde erstellt: {ticket_channel.mention}", ephemeral=True)
            
        except discord.errors.Forbidden:
            await interaction.followup.send("Fehler: Ich habe keine Berechtigung, Kanäle zu erstellen.", ephemeral=True)

class TicketView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(TicketSelect())

# --- BOT SETUP ---
intents = discord.Intents.default()
intents.members = True
intents.presences = True
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Speichert die Message-IDs der Warteraum-Benachrichtigungen {user_id: message_id}
waiting_room_notifications = {}

@tasks.loop(minutes=10)
async def background_update():
    await update_member_count(delay=0)

@tasks.loop(seconds=30)
async def sync_activity():
    guild = bot.get_guild(CONFIG.get("GUILD_ID"))
    if not guild:
        return
    
    target_member = guild.get_member(CONFIG.get("TARGET_USER_ID"))
    
    if target_member and target_member.status != discord.Status.offline:
        if target_member.activities:
            activity = target_member.activity
            if activity:
                await bot.change_presence(activity=activity)
        else:
            await bot.change_presence(activity=None)
    else:
        new_activity = discord.Game(name="Wartet darauf, das Raze Roleplay wieder online ist...")
        await bot.change_presence(activity=new_activity)

async def update_member_count(delay=2):
    if not bot.is_ready():
        return
    
    if delay > 0:
        await asyncio.sleep(delay)
    
    guild = bot.get_guild(CONFIG.get("GUILD_ID"))
    if guild is None:
        return

    channel = guild.get_channel(CONFIG.get("CHANNEL_ID"))
    if channel is None:
        return

    member_count = guild.member_count
    new_name = CONFIG.get("CHANNEL_NAME_FORMAT", "Member: {count}").format(count=member_count)

    if channel.name != new_name:
        try:
            await channel.edit(name=new_name)
            print(f"Kanalname aktualisiert: {new_name}")
        except discord.errors.Forbidden:
            print("Fehler: Keine Berechtigung für Kanaländerung.")
        except discord.errors.HTTPException as e:
            if e.code == 50035: # Rate Limit
                 print(f"Rate Limit: Kanalupdate verzögert sich.")
            else:
                print(f"Fehler bei Kanalupdate: {e}")

async def send_welcome_message(member):
    welcome_channel = bot.get_channel(CONFIG.get("WELCOME_CHANNEL_ID"))
    verify_channel = bot.get_channel(CONFIG.get("VERIFY_CHANNEL_ID"))
    if welcome_channel:
        embed = discord.Embed(
            title="Neuer Bürger eingetroffen!",
            description=f"Herzlich Willkommen auf **Raze Roleplay**, {member.mention}! :wave:\n\n"
                        f"Bitte begib dich in den Kanal {verify_channel.mention if verify_channel else '#verifizieren'}, "
                        "um dich zu verifizieren und am Roleplay teilzunehmen.",
            color=CONFIG.get("ACCENT_COLOR")
        )
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.set_footer(text=f"ID: {member.id}")
        try:
            await welcome_channel.send(embed=embed)
        except Exception as e:
            print(f"Fehler beim Senden der Willkommensnachricht: {e}")

async def send_leave_message(member):
    welcome_channel = bot.get_channel(CONFIG.get("WELCOME_CHANNEL_ID"))
    if welcome_channel:
        embed = discord.Embed(
            title="Bürger hat die Stadt verlassen",
            description=f"**{member.name}** hat Raze Roleplay verlassen. Alles Gute für die Zukunft! :wave:",
            color=CONFIG.get("ACCENT_COLOR")
        )
        if member.display_avatar:
            embed.set_thumbnail(url=member.display_avatar.url)
        embed.set_footer(text=f"ID: {member.id}")
        try:
            await welcome_channel.send(embed=embed)
        except Exception as e:
            print(f"Fehler beim Senden der Abschiedsnachricht: {e}")

BOT_INITIALIZED = False

@bot.event
async def on_ready():
    global BOT_INITIALIZED
    print(f"Eingeloggt als {bot.user.name} ({bot.user.id})")
    print("------")

    # Einmalige Initialisierung (on_ready feuert bei jedem Reconnect erneut)
    if not BOT_INITIALIZED:
        BOT_INITIALIZED = True

        # Start Web Server
        bot.loop.create_task(start_web_server())

        bot.add_view(VerifyView())
        if CONFIG.get("TICKET_TYPES"):
            bot.add_view(TicketView())
        bot.add_view(TicketCloseButton())

    await check_and_send_verify_message()
    await check_and_send_ticket_message()
    
    if not background_update.is_running():
        background_update.start()
    
    if not sync_activity.is_running():
        sync_activity.start()
    
    await update_member_count(delay=0)

async def check_and_send_verify_message():
    channel = bot.get_channel(CONFIG.get("VERIFY_CHANNEL_ID"))
    if channel is None:
        return

    found_msg = False
    async for message in channel.history(limit=50):
        if message.author == bot.user and message.embeds:
            if message.embeds[0].title == "Willkommen auf Raze Roleplay!":
                found_msg = True
                break
    
    if not found_msg:
        embed = discord.Embed(
            title="Willkommen auf Raze Roleplay!",
            description="Bitte drücke auf den **Verifizieren** Button unten, um dich zu verifizieren und Zugriff auf den Server zu erhalten.",
            color=CONFIG.get("ACCENT_COLOR")
        )
        embed.set_footer(text="Raze Roleplay Verifizierung")
        await channel.send(embed=embed, view=VerifyView())
        print("Verifizierungs-Nachricht wurde neu gesendet.")

async def check_and_send_ticket_message():
    channel = bot.get_channel(CONFIG.get("TICKET_CHANNEL_ID"))
    if channel is None:
        return

    # Ohne Ticket-Typen kann das Auswahl-Menü nicht gebaut werden
    if not CONFIG.get("TICKET_TYPES"):
        print("Ticket-Nachricht übersprungen: Keine TICKET_TYPES konfiguriert.")
        return

    found_msg = False
    async for message in channel.history(limit=50):
        if message.author == bot.user and message.embeds:
            if message.embeds[0].title == "Raze Roleplay Support Ticket":
                found_msg = True
                break
    
    if not found_msg:
        embed = discord.Embed(
            title="Raze Roleplay Support Ticket",
            description="Benötigst du Hilfe oder möchtest etwas beantragen?\n\nWähle unten im Menü den passenden Grund aus, um ein Ticket zu eröffnen.\n\n"
                        "• **Allgemeine Frage**\n"
                        "• **Team Bewerbung**\n"
                        "• **Fraktions Antrag**\n"
                        "• **Entbannungs Antrag**",
            color=CONFIG.get("ACCENT_COLOR")
        )
        embed.set_thumbnail(url=CONFIG.get("SERVER_LOGO_URL"))
        embed.set_footer(text="Raze Roleplay - Support System", icon_url=CONFIG.get("SERVER_LOGO_URL"))
        await channel.send(embed=embed, view=TicketView())
        print("Ticket-Nachricht wurde neu gesendet.")

@bot.event
async def on_member_join(member):
    if member.guild.id == CONFIG.get("GUILD_ID"):
        asyncio.create_task(send_welcome_message(member))
        asyncio.create_task(update_member_count())

@bot.event
async def on_member_remove(member):
    if member.guild.id == CONFIG.get("GUILD_ID"):
        asyncio.create_task(send_leave_message(member))
        asyncio.create_task(update_member_count())

@bot.event
async def on_voice_state_update(member, before, after):
    log_channel = bot.get_channel(CONFIG.get("TICKET_LOG_CHANNEL_ID"))
    if not log_channel:
        return
    
    waiting_rooms = CONFIG.get("WAITING_ROOMS", [])

    if after.channel and after.channel.id in waiting_rooms:
        if before.channel is None or before.channel.id != after.channel.id:
            embed = discord.Embed(
                title="Warteraum Support",
                description=f"**{member.mention}** wartet in {after.channel.mention}",
                color=CONFIG.get("ACCENT_COLOR")
            )
            msg = await log_channel.send(embed=embed)
            waiting_room_notifications[member.id] = msg.id

    elif before.channel and before.channel.id in waiting_rooms:
        if after.channel is None or after.channel.id != before.channel.id:
            msg_id = waiting_room_notifications.pop(member.id, None)
            if msg_id:
                try:
                    msg = await log_channel.fetch_message(msg_id)
                    embed = discord.Embed(
                        title="Warteraum Support - Erledigt",
                        description=f"~~{member.name} hat in {before.channel.mention} gewartet.~~\n\n✅ **Anfrage wurde bearbeitet oder User hat den Kanal verlassen.**",
                        color=discord.Color.greyple()
                    )
                    await msg.edit(embed=embed)
                except:
                    pass

@bot.event
async def on_member_update(before, after):
    if before.roles == after.roles:
        return

    mapping = CONFIG.get("ROLE_SYNC_MAPPING", {})
    
    for role_b_id, roles_a_ids in mapping.items():
        role_b = after.guild.get_role(role_b_id)
        if role_b is None:
            continue

        has_any_role_a = any(role.id in roles_a_ids for role in after.roles)
        has_role_b = any(role.id == role_b_id for role in after.roles)

        if has_any_role_a and not has_role_b:
            try:
                await after.add_roles(role_b)
                print(f"Rollen-Sync: {after.name} hat {role_b.name} automatisch erhalten.")
            except discord.errors.Forbidden:
                print(f"Fehler: Keine Berechtigung, {role_b.name} an {after.name} zu vergeben.")
        
        elif not has_any_role_a and has_role_b:
            try:
                await after.remove_roles(role_b)
                print(f"Rollen-Sync: {role_b.name} wurde von {after.name} automatisch entfernt.")
            except discord.errors.Forbidden:
                print(f"Fehler: Keine Berechtigung, {role_b.name} von {after.name} zu entfernen.")

@bot.event
async def on_message(message):
    if message.author.bot:
        return

    # 0. DM Auto-Antwort
    if message.guild is None:
        try:
            embed = discord.Embed(
                title="Raze Roleplay Support",
                description=f"Hey {message.author.name}, bitte keine Privatnachrichten!\n\nBei Fragen oder Problemen melde dich bitte direkt auf unserem Discord-Server:\n{CONFIG.get('DISCORD_INVITE_LINK')}",
                color=CONFIG.get("ACCENT_COLOR")
            )
            embed.set_thumbnail(url=CONFIG.get("SERVER_LOGO_URL"))
            await message.author.send(embed=embed)
        except: pass
        return

    # 1. Medien-Filter (Bilder/Videos)
    if message.channel.id == CONFIG.get("IMAGE_ONLY_CHANNEL_ID"):
        is_image = any(att.content_type and att.content_type.startswith('image/') for att in message.attachments)
        if not is_image:
            try:
                await message.delete()
                await message.channel.send(f"{message.author.mention}, in diesem Kanal sind nur **Bilder** erlaubt!", delete_after=5)
            except: pass
            return
    elif message.channel.id == CONFIG.get("VIDEO_ONLY_CHANNEL_ID"):
        is_video = any(att.content_type and att.content_type.startswith('video/') for att in message.attachments)
        if not is_video:
            try:
                await message.delete()
                await message.channel.send(f"{message.author.mention}, in diesem Kanal sind nur **Videos** erlaubt!", delete_after=5)
            except: pass
            return

    # 2. Automatische Reaktionen
    thumbs_up_channels = CONFIG.get("THUMBS_UP_CHANNELS", [])
    vote_channels = CONFIG.get("VOTE_CHANNELS", {})

    if message.channel.id in thumbs_up_channels:
        try:
            await message.add_reaction("👍")
        except: pass
    elif message.channel.id in vote_channels:
        for emoji in vote_channels[message.channel.id]:
            try:
                await message.add_reaction(emoji)
            except: pass

    # 3. Feedback DM
    if message.channel.id == CONFIG.get("FEEDBACK_CHANNEL_ID"):
        try:
            feedback_text = message.content if message.content else "*Kein Text (nur Anhang)*"
            
            embed = discord.Embed(
                title="Vielen Dank für dein Feedback!",
                description=f"Hallo {message.author.name},\n\nvielen Dank für dein Feedback auf **Raze Roleplay**! Wir schätzen deine Meinung sehr.\n\n**Deine Nachricht:**\n{feedback_text}",
                color=CONFIG.get("ACCENT_COLOR")
            )
            
            if message.attachments:
                embed.set_image(url=message.attachments[0].url)
            
            embed.set_thumbnail(url=CONFIG.get("SERVER_LOGO_URL"))
            embed.set_footer(text="Raze Roleplay - Community Feedback", icon_url=CONFIG.get("SERVER_LOGO_URL"))
            
            await message.author.send(embed=embed)
            print(f"Feedback-Bestätigung an {message.author.name} gesendet.")
        except discord.errors.Forbidden:
            print(f"Konnte keine DM an {message.author.name} senden (DMs deaktiviert).")
        except Exception as e:
            print(f"Fehler beim Senden der Feedback-DM: {e}")

    await bot.process_commands(message)

def main():
    # CLI-Helfer: verschlüsselten Token für config.json erzeugen
    #   python bot.py --encrypt-token            (interaktiv)
    #   python bot.py --encrypt-token <token>    (direkt)
    if "--encrypt-token" in sys.argv:
        idx = sys.argv.index("--encrypt-token")
        plain = sys.argv[idx + 1] if len(sys.argv) > idx + 1 else input("Discord-Token: ").strip()
        if not plain:
            print("Kein Token angegeben.")
        else:
            if os.environ.get("RAZE_TOKEN_KEY"):
                print("(Verschlüsselt mit RAZE_TOKEN_KEY aus der Umgebung.)")
            else:
                print("(Verschlüsselt mit Standardschlüssel - für mehr Schutz RAZE_TOKEN_KEY setzen.)")
            print("\nFüge diesen Wert als \"TOKEN\" in config.json ein:\n")
            print(encrypt_token(plain))
        return

    def token_fehler_hinweis(grund):
        print("\n" + "=" * 70)
        print(f"  DISCORD-LOGIN FEHLGESCHLAGEN: {grund}")
        print("  Der Bot wird NICHT mit Discord verbunden.")
        print("  Das Web-Panel wird trotzdem gestartet, damit du unter")
        print("  'Allgemein -> Bot Token' einen gültigen Token eintragen kannst.")
        print("  Danach den Bot einmal neu starten.")
        print("=" * 70 + "\n")

    token = get_bot_token()
    if not token:
        token_fehler_hinweis("Kein Token konfiguriert (TOKEN in config.json leer).")
        run_web_server_only()
    else:
        try:
            bot.run(token)
        except discord.errors.LoginFailure:
            # Ungültiger/abgelaufener Token -> Discord lehnt mit 401 ab
            token_fehler_hinweis("Der Discord-Bot-Token ist ungültig oder abgelaufen (401 Unauthorized).")
            run_web_server_only()
        except discord.errors.PrivilegedIntentsRequired:
            # Benötigte Intents im Developer Portal nicht aktiviert
            print("\n" + "=" * 70)
            print("  FEHLER: Benötigte 'Privileged Gateway Intents' sind nicht aktiviert.")
            print("  Aktiviere im Discord Developer Portal (Bot -> Privileged Gateway")
            print("  Intents) 'Server Members Intent' und 'Presence Intent'.")
            print("  Das Web-Panel wird trotzdem gestartet.")
            print("=" * 70 + "\n")
            run_web_server_only()

if __name__ == "__main__":
    main()
