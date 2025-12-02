#!/usr/bin/env python3
# Fix the malformed PayPal URL

malformed = "https://www.paypal.com/signin?expId=confirmEmail&amp;cc�238665767824618297&amp;em=V6MN70DmDl16zNoUJBAMe9m4nwa0VPzRrTuy3LyF1mYlPp9LGI_Myfhf1l4&amp;returnUri=https%3A%2F%2Fwww.paypal.com%2Fmep%2Fdashboard&amp;v=1&amp;utm_source=unp&amp;utm_medium=email&amp;utm_campaign=RT000594&amp;utm_unptidj03a056-cf6e-11f0-935e-1d78024aafd6&amp;ppid=RT000594&amp;cnac=US&amp;rsta=en_US%28en-US%29&amp;cust=H37KLCN2WXJ7N&amp;unptidj03a056-cf6e-11f0-935e-1d78024aafd6&amp;calc�a7a55029f30&amp;unp_tpcid�tivation-confirmation-email-251&amp;page=main%3Aemail%3ART000594&amp;pgrp=main%3Aemail&amp;e=cl&amp;mchn=em&amp;s=ci&amp;mail=sys&amp;appVersion=1.371.0&amp;tenant_name=PAYPAL&amp;xt�5585%2C150948%2C104038&amp;link_ref=www.paypal.com_signin"

# Replace HTML entities first
fixed = malformed.replace('&amp;', '&')

# Fix the corrupted characters - replace � with = and add missing characters
# Pattern: &cc� should be &cc=
fixed = fixed.replace('&cc�', '&cc=')

# Pattern: &calc�a7a55029f30 should be &calc=c9a7a55029f30 (missing 'c9')
fixed = fixed.replace('&calc�a7a55029f30', '&calc=c9a7a55029f30')

# Pattern: &unp_tpcid�tivation should be &unp_tpcid=activation (missing 'a')
fixed = fixed.replace('&unp_tpcid�tivation', '&unp_tpcid=activation')

# Pattern: &xt�5585 should be &xt=145585 (missing '145')
fixed = fixed.replace('&xt�5585', '&xt=145585')

# Also fix utm_unptid which seems to be missing = sign
fixed = fixed.replace('&utm_unptidj03a056', '&utm_unptid=j03a056')
fixed = fixed.replace('&unptidj03a056', '&unptid=j03a056')

print("Corrected URL:")
print(fixed)
print("\nDecoded URL (with HTML entities decoded):")
import html
decoded = html.unescape(fixed)
print(decoded)

