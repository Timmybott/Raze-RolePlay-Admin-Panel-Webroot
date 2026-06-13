
import os

file_path = r"c:\Users\Stulle\Desktop\Test Prog\Raze RolePlay Admin Panel (neu) (aktuelles) (in arbeit)\Panel Webseite\script.js"

try:
    with open(file_path, 'rb') as f:
        content = f.read()

    # The file likely has a mix of UTF-8 and UTF-16LE/BE appended.
    # The 'type >>' command often appends UTF-16LE BOM + content.
    
    # Let's try to decode as much as possible or just filter out null bytes which are likely 0x00 from UTF-16
    # But wait, purely removing null bytes might break genuine UTF-16 characters if they exist (unlikely in this source code).
    # Since it's source code, it should be ASCII/UTF-8 compatible.
    
    clean_content = content.replace(b'\x00', b'')
    
    # Also chances are there are some BOM bytes in the middle now.
    # UTF-16LE BOM is \xFF\xFE.
    clean_content = clean_content.replace(b'\xff\xfe', b'')
    
    # Convert to string to normalize
    text = clean_content.decode('utf-8', errors='ignore')
    
    # Write back as clean UTF-8
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(text)
        
    print("Successfully cleaned script.js")

except Exception as e:
    print(f"Error: {e}")
