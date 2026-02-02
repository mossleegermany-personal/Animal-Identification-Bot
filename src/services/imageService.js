// Image Service - Create composite images with photo + text side by side

const sharp = require('sharp');

// Font family that works across systems (Azure Linux, macOS, Windows)
const FONT_FAMILY = 'sans-serif';

/**
 * Create a composite image with photo on left, text panel on right
 * Layout: Badges | Names
 */
async function createCompositeImage(photoUrl, data) {
  try {
    console.log('🖼️  Creating composite image...');
    
    const { commonName, scientificName, taxonomy, sex, lifeStage, morph } = data;
    const subspecies = taxonomy?.subspecies || 'Not determined';
    
    // Debug logging for badge data
    console.log('   📊 Badge data:', { sex, lifeStage, morph, subspecies: taxonomy?.subspecies });
    
    // Fetch the photo
    const photoResponse = await fetch(photoUrl);
    const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
    
    // Get photo dimensions
    const photoMeta = await sharp(photoBuffer).metadata();
    const photoHeight = photoMeta.height || 400;
    const photoWidth = photoMeta.width || 400;
    
    // Target dimensions
    const targetHeight = Math.min(photoHeight, 650);
    const targetPhotoWidth = Math.round(targetHeight * (photoWidth / photoHeight));
    const textPanelWidth = 480;
    const totalWidth = targetPhotoWidth + textPanelWidth;
    
    // Resize photo
    const resizedPhoto = await sharp(photoBuffer)
      .resize(targetPhotoWidth, targetHeight, { fit: 'cover' })
      .toBuffer();
    
    // === HEADER: Build badges ===
    const badges = [];
    
    // Taxonomy level badge
    if (taxonomy?.subspecies && taxonomy.subspecies !== 'Not determined' && taxonomy.subspecies !== 'Unable to determine from image') {
      badges.push({ text: 'SUBSPECIES', color: '#1565C0' }); // Blue
    } else if (taxonomy?.species) {
      badges.push({ text: 'SPECIES', color: '#455A64' }); // Gray
    }
    
    // Sex badge - improved detection
    if (sex) {
      const sexLower = sex.toLowerCase();
      // Check for male (but not "female" which contains "male")
      if ((sexLower.includes('male') && !sexLower.includes('female')) || 
          sexLower.startsWith('m ') || sexLower === 'm') {
        badges.push({ text: 'MALE', color: '#6A1B9A' }); // Purple
      } else if (sexLower.includes('female') || sexLower.startsWith('f ') || sexLower === 'f') {
        badges.push({ text: 'FEMALE', color: '#6A1B9A' }); // Purple
      }
      // Skip if "unknown", "undetermined", "cannot determine", etc.
    }
    
    // Life stage badge
    if (lifeStage && !lifeStage.toLowerCase().includes('unknown')) {
      const stageText = lifeStage.split(' ')[0].toUpperCase();
      badges.push({ text: stageText, color: '#E65100' }); // Orange
    }
    
    // Morph badge
    if (morph && morph !== 'null' && morph !== null) {
      badges.push({ text: morph.toUpperCase(), color: '#AD1457' }); // Pink
    }
    
    // Generate badge SVG - dynamic horizontal layout with smaller gaps
    let badgeSvg = '';
    const headerY = 25;
    const badgeGap = 8; // Gap between badges
    let currentX = 20;
    
    badges.forEach((badge) => {
      const textWidth = badge.text.length * 9 + 20; // Slightly smaller padding
      
      badgeSvg += `
        <rect x="${currentX}" y="${headerY}" width="${textWidth}" height="28" rx="14" fill="${badge.color}"/>
        <text x="${currentX + textWidth/2}" y="${headerY + 19}" font-family="${FONT_FAMILY}" font-size="12" font-weight="bold" fill="white" text-anchor="middle">
          ${escapeXml(badge.text)}
        </text>
      `;
      currentX += textWidth + badgeGap;
    });
    
    // Calculate body start position (single row of badges)
    const headerHeight = headerY + 28 + 20; // badge height + padding
    
    // === BODY: Name information ===
    const bodyY = headerHeight;
    
    // Check if subspecies is valid (not "Not determined" or similar)
    const hasValidSubspecies = subspecies && 
      subspecies !== 'Not determined' && 
      subspecies !== 'Unable to determine from image' &&
      subspecies !== 'monotypic' &&
      !subspecies.toLowerCase().includes('unknown');
    
    // Build subspecies section only if valid
    const subspeciesSection = hasValidSubspecies ? `
        <!-- Subspecies section -->
        <text x="20" y="${bodyY + 110}" font-family="${FONT_FAMILY}" font-size="12" fill="#666666" font-weight="bold">
          SUBSPECIES
        </text>
        <text x="20" y="${bodyY + 135}" font-family="${FONT_FAMILY}" font-size="22" font-style="italic" fill="#999999">
          ${escapeXml(subspecies)}
        </text>
    ` : '';

    // Create text panel SVG
    const textSvg = `
      <svg width="${textPanelWidth}" height="${targetHeight}">
        <rect width="100%" height="100%" fill="#1a1a1a"/>
        
        <!-- HEADER: Badges -->
        ${badgeSvg}
        
        <!-- Divider line -->
        <line x1="20" y1="${headerHeight - 5}" x2="${textPanelWidth - 20}" y2="${headerHeight - 5}" stroke="#333333" stroke-width="1"/>
        
        <!-- BODY: Species Info -->
        <text x="20" y="${bodyY + 35}" font-family="${FONT_FAMILY}" font-size="36" font-weight="bold" fill="white">
          ${escapeXml(commonName)}
        </text>
        <text x="20" y="${bodyY + 70}" font-family="${FONT_FAMILY}" font-size="20" font-style="italic" fill="#bbbbbb">
          ${escapeXml(scientificName)}
        </text>
        
        ${subspeciesSection}
      </svg>
    `;
    
    const textPanel = await sharp(Buffer.from(textSvg))
      .png()
      .toBuffer();
    
    // Composite the images side by side
    const composite = await sharp({
      create: {
        width: totalWidth,
        height: targetHeight,
        channels: 4,
        background: { r: 26, g: 26, b: 26, alpha: 1 }
      }
    })
      .composite([
        { input: resizedPhoto, left: 0, top: 0 },
        { input: textPanel, left: targetPhotoWidth, top: 0 }
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
    
    console.log('   ✅ Composite image created');
    return composite;
    
  } catch (error) {
    console.error('Image composite error:', error.message);
    return null;
  }
}

/**
 * Escape special XML characters
 */
function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  createCompositeImage
};
