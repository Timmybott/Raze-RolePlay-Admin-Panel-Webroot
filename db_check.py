# Eigenständiges DB-Diagnose-Skript für das Raze Admin-Panel.
# AUF DEM SERVER im webroot-Ordner ausführen:  python db_check.py
# Gibt Schritt für Schritt aus, wo es klemmt (dotenv / pymysql / .env / Verbindung / Rechte).
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
print("=" * 60)
print("Python    :", sys.version.split()[0], "(" + sys.executable + ")")
print("Verzeichnis:", HERE)
print("=" * 60)

# 1) python-dotenv + .env laden
env_path = os.path.join(HERE, ".env")
print("[1] .env vorhanden neben db_check.py:", os.path.exists(env_path), "->", env_path)
try:
    from dotenv import load_dotenv
    load_dotenv(env_path)
    print("    python-dotenv: OK")
except Exception as e:
    print("    python-dotenv FEHLT/Fehler:", repr(e), " -> 'pip install python-dotenv'")

# 2) pymysql
try:
    import pymysql
    print("[2] pymysql: OK, Version", getattr(pymysql, "__version__", "?"))
except Exception as e:
    print("[2] pymysql FEHLT:", repr(e))
    print("    -> Auf dem Server ausführen:  pip install pymysql")
    sys.exit(1)

# 3) Connection-String aus der Umgebung – sonst der fest hinterlegte Default (wie in bot.py)
HARDCODED = "mysql://u44557_etCbfVyAVd:lqmh6ORO!dC+2MzXeG=.BEue@de13.spaceify.eu/s44557_mysql?charset=utf8mb4"
cs = os.environ.get("MYSQL_CONNECTION_STRING") or os.environ.get("mysql_connection_string") or HARDCODED
print("[3] Connection-String: %s (Länge %d)." % (
    "aus .env/Umgebung" if (os.environ.get("MYSQL_CONNECTION_STRING") or os.environ.get("mysql_connection_string")) else "fest im Code hinterlegt", len(cs)))
print("    Beginnt mit:", repr(cs[:10]), "(muss 'mysql://' sein – KEIN führendes Anführungszeichen!)")

from urllib.parse import urlparse, parse_qs
u = urlparse(cs.strip())
conf = dict(host=u.hostname, port=u.port or 3306, user=u.username or "",
            password=u.password or "", database=(u.path or "").strip("/"),
            charset=(parse_qs(u.query).get("charset", ["utf8mb4"])[0]))
print("    geparst: host=%s port=%s user=%s db=%s charset=%s (Passwort-Länge=%d)" % (
    conf["host"], conf["port"], conf["user"], conf["database"], conf["charset"], len(conf["password"])))

# 4) Verbindung
try:
    conn = pymysql.connect(host=conf["host"], port=conf["port"], user=conf["user"],
                           password=conf["password"], database=conf["database"],
                           charset=conf["charset"], connect_timeout=8, autocommit=True)
    print("[4] Verbindung zur DB: OK")
except Exception as e:
    print("[4] Verbindung FEHLGESCHLAGEN:")
    print("    ", repr(e))
    print("    Typische Gründe: falsches Passwort/User, DB erlaubt nur localhost,")
    print("    Bot läuft doch nicht auf demselben Host wie die DB, Firewall.")
    sys.exit(1)

# 5) Tabelle anlegen + auflisten (testet auch die Schreib-/CREATE-Rechte)
try:
    with conn.cursor() as cur:
        cur.execute("CREATE TABLE IF NOT EXISTS raze_panel_config "
                    "(ckey VARCHAR(191) PRIMARY KEY, cvalue LONGTEXT) "
                    "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
        cur.execute("SHOW TABLES LIKE 'raze_panel_%'")
        tabs = [r[0] for r in cur.fetchall()]
    print("[5] CREATE TABLE: OK. Vorhandene raze_panel_* Tabellen:", tabs)
    print()
    print(">>> ALLES OK. Die DB funktioniert. Jetzt nur noch den Bot NEU STARTEN,")
    print(">>> dann legt er beim Start die restlichen Tabellen an und migriert die JSONs.")
except Exception as e:
    print("[5] Tabelle anlegen FEHLGESCHLAGEN (CREATE-Recht fehlt?):", repr(e))
finally:
    conn.close()
