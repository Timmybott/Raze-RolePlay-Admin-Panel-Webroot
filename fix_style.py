
import os

file_path = r"c:\Users\Stulle\Desktop\Test Prog\Raze RolePlay Admin Panel (neu) (aktuelles) (in arbeit)\Panel Webseite\style.css"

try:
    with open(file_path, 'rb') as f:
        content = f.read()

    # Clean null bytes (often from UTF-16LE when read as binary)
    clean_content = content.replace(b'\x00', b'')
    # Remove BOM if present inside content
    clean_content = clean_content.replace(b'\xff\xfe', b'')
    
    # Decode
    text = clean_content.decode('utf-8', errors='ignore')
    
    # Write back
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(text)
        
    print("Successfully cleaned style.css")

except Exception as e:
    print(f"Error: {e}")
