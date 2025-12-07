#!/usr/bin/env node
/**
 * Generate a simple favicon.ico file with a mail icon
 * This creates a minimal 16x16 ICO file
 */

const fs = require('fs');
const path = require('path');

// Minimal ICO file structure for a 16x16 icon
// ICO format: Header + Directory + Image Data
function createFaviconICO() {
  // This is a minimal 16x16 mail icon in ICO format
  // Using a simple approach: create a minimal ICO with a basic mail icon
  
  // ICO file header (6 bytes)
  const header = Buffer.from([
    0x00, 0x00, // Reserved (must be 0)
    0x01, 0x00, // Type (1 = ICO)
    0x01, 0x00  // Number of images
  ]);
  
  // Image directory entry (16 bytes per image)
  // For a 16x16 32-bit RGBA image
  const width = 16;
  const height = 16;
  const colors = 0; // 0 = no palette (32-bit RGBA)
  const reserved = 0;
  const planes = 1;
  const bitCount = 32; // 32-bit RGBA
  const size = 16 * 16 * 4 + 40; // Image data size (BMP header + pixels)
  const offset = 22; // Offset to image data (header + directory)
  
  const directory = Buffer.from([
    width === 256 ? 0 : width,  // Width (0 if 256)
    height === 256 ? 0 : height, // Height (0 if 256)
    colors & 0xFF,               // Color palette (0 = no palette)
    reserved,                    // Reserved
    planes & 0xFF,               // Color planes (low byte)
    (planes >> 8) & 0xFF,        // Color planes (high byte)
    bitCount & 0xFF,              // Bits per pixel (low byte)
    (bitCount >> 8) & 0xFF,       // Bits per pixel (high byte)
    size & 0xFF,                  // Image size (bytes 0-3)
    (size >> 8) & 0xFF,
    (size >> 16) & 0xFF,
    (size >> 24) & 0xFF,
    offset & 0xFF,                // Offset to image data (bytes 0-3)
    (offset >> 8) & 0xFF,
    (offset >> 16) & 0xFF,
    (offset >> 24) & 0xFF
  ]);
  
  // BMP header (40 bytes) - ICO files contain BMP data
  const bmpHeader = Buffer.alloc(40);
  bmpHeader.writeUInt32LE(40, 0);        // Header size
  bmpHeader.writeInt32LE(width, 4);      // Width
  bmpHeader.writeInt32LE(height * 2, 8); // Height (doubled for ICO format)
  bmpHeader.writeUInt16LE(1, 12);        // Planes
  bmpHeader.writeUInt16LE(32, 14);       // Bits per pixel
  bmpHeader.writeUInt32LE(0, 16);        // Compression (0 = none)
  bmpHeader.writeUInt32LE(0, 20);        // Image size (can be 0)
  bmpHeader.writeInt32LE(0, 24);         // X pixels per meter
  bmpHeader.writeInt32LE(0, 28);         // Y pixels per meter
  bmpHeader.writeUInt32LE(0, 32);        // Colors used
  bmpHeader.writeUInt32LE(0, 36);        // Important colors
  
  // Create a simple mail icon: blue background with white envelope
  const pixels = Buffer.alloc(width * height * 4);
  const blue = 0x2d72d9; // #2d72d9
  const white = 0xffffff;
  const transparent = 0x00000000;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      
      // Blue background
      let r = (blue >> 16) & 0xFF;
      let g = (blue >> 8) & 0xFF;
      let b = blue & 0xFF;
      let a = 255;
      
      // Draw white envelope shape
      const centerX = width / 2;
      const centerY = height / 2;
      const envelopeWidth = 10;
      const envelopeHeight = 7;
      
      const relX = x - centerX;
      const relY = y - centerY;
      
      // Envelope body (rectangle)
      if (Math.abs(relX) < envelopeWidth / 2 && Math.abs(relY) < envelopeHeight / 2) {
        r = g = b = 255; // White
      }
      
      // Envelope flap (triangle at top)
      if (relY < -envelopeHeight / 2 + 2 && Math.abs(relX) < envelopeWidth / 2 - Math.abs(relY + envelopeHeight / 2 - 2)) {
        r = g = b = 255; // White
      }
      
      // Envelope border
      if (Math.abs(relX) === Math.floor(envelopeWidth / 2) || 
          Math.abs(relY) === Math.floor(envelopeHeight / 2) ||
          (relY < -envelopeHeight / 2 + 2 && Math.abs(relX) === Math.floor(envelopeWidth / 2 - Math.abs(relY + envelopeHeight / 2 - 2)))) {
        r = g = b = 200; // Light gray border
      }
      
      // BMP format stores pixels bottom-to-top, BGR (not RGB), and with alpha
      pixels[idx] = b;     // Blue
      pixels[idx + 1] = g;  // Green
      pixels[idx + 2] = r;  // Red
      pixels[idx + 3] = a;  // Alpha
    }
  }
  
  // Combine all parts
  const icoFile = Buffer.concat([header, directory, bmpHeader, pixels]);
  
  return icoFile;
}

// Generate and save favicon.ico
const faviconPath = path.join(__dirname, '..', 'favicon.ico');
const icoData = createFaviconICO();
fs.writeFileSync(faviconPath, icoData);
console.log(`✓ Generated favicon.ico (${icoData.length} bytes)`);





