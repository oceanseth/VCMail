#!/bin/bash
# Script to analyze raw email from S3

MESSAGE_ID="${1:-ng5khvjqvgcg7fqerigjh97uvkebnb95j0forco1}"
BUCKET_NAME="${2:-voicecert-com-mail-inbox}"

echo "📧 Analyzing email: $MESSAGE_ID"
echo "📦 Bucket: $BUCKET_NAME"
echo ""

# Download the email
echo "⬇️  Downloading email from S3..."
aws s3 cp "s3://${BUCKET_NAME}/${MESSAGE_ID}" "./email-raw-${MESSAGE_ID}.txt" || {
    echo "❌ Failed to download. Trying common bucket names..."
    # Try common bucket name patterns
    for bucket in "${BUCKET_NAME}" "vcmail-mail-inbox" "voicecert-com-mail-inbox"; do
        echo "Trying bucket: $bucket"
        if aws s3 cp "s3://${bucket}/${MESSAGE_ID}" "./email-raw-${MESSAGE_ID}.txt" 2>/dev/null; then
            echo "✅ Downloaded from: $bucket"
            BUCKET_NAME="$bucket"
            break
        fi
    done
}

if [ ! -f "./email-raw-${MESSAGE_ID}.txt" ]; then
    echo "❌ Could not download email. Please check bucket name and message ID."
    exit 1
fi

echo ""
echo "📊 Email Analysis:"
echo "=================="
echo ""

# File size
FILE_SIZE=$(wc -c < "./email-raw-${MESSAGE_ID}.txt")
echo "📏 File size: $FILE_SIZE bytes ($(echo "scale=2; $FILE_SIZE/1024" | bc) KB)"

# Content-Type
echo ""
echo "📋 Headers:"
echo "-----------"
CONTENT_TYPE=$(grep -i "^Content-Type:" "./email-raw-${MESSAGE_ID}.txt" | head -1)
echo "Content-Type: $CONTENT_TYPE"

# Check if multipart
if echo "$CONTENT_TYPE" | grep -qi "multipart"; then
    echo "✅ Email is MULTIPART (should have attachments)"
    
    # Extract boundary
    BOUNDARY=$(echo "$CONTENT_TYPE" | grep -oP 'boundary=["\047]?([^"\047;]+)' | sed 's/boundary=["\047]//' | sed 's/["\047]//')
    echo "Boundary: $BOUNDARY"
    
    # Count parts
    PARTS=$(grep -c "^--${BOUNDARY}" "./email-raw-${MESSAGE_ID}.txt" || echo "0")
    echo "Number of parts: $PARTS"
    
    echo ""
    echo "📎 Attachment Analysis:"
    echo "----------------------"
    
    # Look for Content-Disposition headers
    echo "Content-Disposition headers:"
    grep -i "Content-Disposition:" "./email-raw-${MESSAGE_ID}.txt" | head -10
    
    echo ""
    echo "Filenames found:"
    grep -i "filename=" "./email-raw-${MESSAGE_ID}.txt" | head -10
    
    echo ""
    echo "Content-Type of parts:"
    grep -i "^Content-Type:" "./email-raw-${MESSAGE_ID}.txt" | head -10
    
else
    echo "⚠️  Email is NOT multipart (single part email)"
fi

echo ""
echo "📄 First 200 characters:"
echo "------------------------"
head -c 200 "./email-raw-${MESSAGE_ID}.txt"
echo ""
echo ""

# Cleanup
# Uncomment to auto-delete:
# rm "./email-raw-${MESSAGE_ID}.txt"


