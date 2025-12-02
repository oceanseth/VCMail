#!/usr/bin/env python3
import re
import quopri

# Read the email file
with open('latest_email.txt', 'r', encoding='utf-8') as f:
    email_content = f.read()

# Find the HTML part (between the boundary markers)
boundary = "Apple-Mail-A09F7E62-F8D0-44A2-A336-ACC3AE50D0F0"
html_start = email_content.find(f"--{boundary}\nContent-Type: text/html;")
if html_start == -1:
    print("Could not find HTML part")
    exit(1)

# Find the end of HTML part
html_end = email_content.find(f"\n--{boundary}--", html_start)
if html_end == -1:
    html_end = email_content.find(f"\n--{boundary}", html_start + 1)

# Extract HTML content
html_section = email_content[html_start:html_end]

# Find where the actual HTML body starts (after headers)
body_start = html_section.find('\n\n')
if body_start == -1:
    body_start = html_section.find('\r\n\r\n')
if body_start == -1:
    body_start = 0
else:
    body_start += 2

html_body = html_section[body_start:]

# Decode quoted-printable
decoded_html = quopri.decodestring(html_body).decode('utf-8')

print("=" * 80)
print("DECODED HTML CONTENT:")
print("=" * 80)
try:
    print(decoded_html)
except UnicodeEncodeError:
    # Write to file instead
    with open('decoded_html.txt', 'w', encoding='utf-8') as f:
        f.write(decoded_html)
    print("(Content written to decoded_html.txt due to encoding issues)")
print("\n" + "=" * 80)
print("EXTRACTED LINKS:")
print("=" * 80)

# Extract all href links
links = re.findall(r'href=["\']([^"\']+)["\']', decoded_html)
for i, link in enumerate(links, 1):
    print(f"\nLink {i}:")
    print(link)

# Also check for any links in the raw quoted-printable
print("\n" + "=" * 80)
print("RAW QUOTED-PRINTABLE LINKS (before decoding):")
print("=" * 80)
raw_links = re.findall(r'href=3D["\']([^"\']+)["\']', html_body)
for i, link in enumerate(raw_links, 1):
    print(f"\nRaw Link {i}:")
    print(link)
    # Decode this specific link
    decoded_link = quopri.decodestring(link.encode('utf-8')).decode('utf-8')
    print(f"Decoded: {decoded_link}")

