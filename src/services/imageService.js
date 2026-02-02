// Image Service - Create composite images with photo + text side by side

const sharp = require('sharp');

// Font family - DejaVu Sans is installed via startup.sh on Azure
// Falls back to system fonts on local development
const FONT_FAMILY = 'DejaVu Sans, Liberation Sans, FreeSans, sans-serif';

/**
 * Create a composite image with photo on left, text panel on right
 * Layout: Badges | Names
 */
async function createCompositeImage(photoUrl, data) {
  try {
    console.log('🖼️  Creating composite image (HD quality)...');
    
    const { commonName, scientificName, taxonomy, sex, lifeStage, morph, identificationLevel } = data;
    const subspecies = taxonomy?.subspecies || null;
    
    // Debug logging for badge data
    console.log('   📊 Badge data:', { identificationLevel, sex, lifeStage, morph, subspecies: taxonomy?.subspecies });
    
    // Fetch the photo
    const photoResponse = await fetch(photoUrl);
    const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
    
    // Fix orientation and get metadata
    const orientedPhoto = await sharp(photoBuffer)
      .rotate() // Auto-rotate based on EXIF orientation
      .toBuffer();
    
    // Get photo dimensions after orientation fix
    const photoMeta = await sharp(orientedPhoto).metadata();
    const photoHeight = photoMeta.height || 400;
    const photoWidth = photoMeta.width || 400;
    
    // Target dimensions - higher resolution for HD quality
    const targetHeight = Math.max(600, Math.min(photoHeight, 900));
    const targetPhotoWidth = Math.round(targetHeight * (photoWidth / photoHeight));
    const textPanelWidth = 550;
    const totalWidth = targetPhotoWidth + textPanelWidth;
    
    // Resize photo with high quality settings
    const resizedPhoto = await sharp(orientedPhoto)
      .resize(targetPhotoWidth, targetHeight, { 
        fit: 'cover',
        kernel: sharp.kernel.lanczos3 // High quality resampling
      })
      .toBuffer();
    
    // === BUILD BADGES (organized by category) ===
    const primaryBadge = []; // Taxonomy level
    const attributeBadges = []; // Sex, Life stage, Morph
    
    // Taxonomy level badge - based on identificationLevel from Gemini
    const level = (identificationLevel || 'species').toLowerCase();
    if (level === 'subspecies' && subspecies && 
        subspecies !== 'monotypic' && 
        !subspecies.toLowerCase().includes('null')) {
      primaryBadge.push({ text: 'SUBSPECIES', color: '#0D47A1', icon: '◉' }); // Dark Blue
    } else if (level === 'genus') {
      primaryBadge.push({ text: 'GENUS', color: '#6A1B9A', icon: '◎' }); // Purple
    } else if (level === 'family') {
      primaryBadge.push({ text: 'FAMILY', color: '#4A148C', icon: '○' }); // Dark Purple
    }
    // Don't show SPECIES badge - it's the default level
    
    // Sex badge - only show if CONFIRMED male or female (not uncertain)
    if (sex) {
      const sexLower = sex.toLowerCase();
      // Skip if contains uncertainty words
      const isUncertain = sexLower.includes('unknown') || 
                          sexLower.includes('uncertain') || 
                          sexLower.includes('unsure') ||
                          sexLower.includes('unclear') ||
                          sexLower.includes('undetermined') ||
                          sexLower.includes('cannot') ||
                          sexLower.includes('possibly') ||
                          sexLower.includes('likely') ||
                          sexLower.includes('probably');
      
      if (!isUncertain) {
        if ((sexLower.includes('male') && !sexLower.includes('female')) || 
            sexLower.startsWith('m ') || sexLower === 'm') {
          attributeBadges.push({ text: 'MALE', color: '#1565C0', icon: '♂' }); // Dark Blue
        } else if (sexLower.includes('female') || sexLower.startsWith('f ') || sexLower === 'f') {
          attributeBadges.push({ text: 'FEMALE', color: '#AD1457', icon: '♀' }); // Dark Pink/Magenta
        }
      }
    }
    
    // Life stage badge - short text only
    if (lifeStage && !lifeStage.toLowerCase().includes('unknown')) {
      const stageLower = lifeStage.toLowerCase();
      let stageText = 'ADULT';
      let stageIcon = '●';
      
      if (stageLower.includes('juvenile') || stageLower.includes('juv')) {
        stageText = 'JUVENILE';
        stageIcon = '◐';
      } else if (stageLower.includes('immature') || stageLower.includes('imm')) {
        stageText = 'IMMATURE';
        stageIcon = '◐';
      } else if (stageLower.includes('chick')) {
        stageText = 'CHICK';
        stageIcon = '○';
      } else if (stageLower.includes('adult')) {
        stageText = 'ADULT';
        stageIcon = '●';
      } else {
        // Skip if not a recognized stage
        stageText = null;
      }
      
      if (stageText) {
        attributeBadges.push({ text: stageText, color: '#E65100', icon: stageIcon });
      }
    }
    
    // Morph badge - truncate long text
    if (morph && morph !== 'null' && morph !== null) {
      let morphText = morph.toUpperCase();
      if (morphText.length > 10) morphText = morphText.substring(0, 8);
      attributeBadges.push({ text: morphText, color: '#00695C', icon: '◆' }); // Dark Teal
    }
    
    // Combine all badges for row layout
    const allBadges = [...primaryBadge, ...attributeBadges];
    
    // Check if we should show subspecies section (only when identified at subspecies level)
    const hasValidSubspecies = level === 'subspecies' && subspecies && 
      subspecies !== 'monotypic' && 
      !subspecies.toLowerCase().includes('null') &&
      !subspecies.toLowerCase().includes('unknown');
    
    // === GENERATE BADGE SVG - 2 per row, balanced size ===
    let badgeSvg = '';
    const startY = 24;
    const badgeHeight = 32;
    const rowGap = 8;
    const padding = 20;
    const maxBadgeWidth = 200;
    
    allBadges.forEach((badge, index) => {
      const row = Math.floor(index / 2);
      const col = index % 2;
      let badgeWidth = Math.min(badge.text.length * 11 + 48, maxBadgeWidth);
      const xOffset = padding + col * (maxBadgeWidth + 10);
      const yOffset = startY + row * (badgeHeight + rowGap);
      
      // Badge - proportional size
      badgeSvg += `
        <rect x="${xOffset}" y="${yOffset}" width="${badgeWidth}" height="${badgeHeight}" rx="6" fill="${badge.color}"/>
        <text x="${xOffset + 10}" y="${yOffset + 22}" font-family="${FONT_FAMILY}" font-size="16" font-weight="bold" fill="white">
          ${badge.icon}
        </text>
        <text x="${xOffset + 30}" y="${yOffset + 22}" font-family="${FONT_FAMILY}" font-size="14" font-weight="700" fill="white" letter-spacing="0.5">
          ${escapeXml(badge.text)}
        </text>
      `;
    });
    
    // Calculate body start position based on number of badge rows
    const badgeRows = Math.ceil(allBadges.length / 2) || 1;
    const headerHeight = startY + (badgeRows * (badgeHeight + rowGap)) + 16;
    
    // === BODY: Name information ===
    const bodyY = headerHeight;
    
    // Word wrap helper for long text
    const wrapText = (text, maxChars) => {
      if (text.length <= maxChars) return [text];
      const words = text.split(' ');
      const lines = [];
      let currentLine = '';
      
      words.forEach(word => {
        if ((currentLine + ' ' + word).trim().length <= maxChars) {
          currentLine = (currentLine + ' ' + word).trim();
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      });
      if (currentLine) lines.push(currentLine);
      return lines;
    };
    
    // Wrap common name if too long (max ~20 chars per line for font size 38)
    const commonNameLines = wrapText(commonName, 20);
    const commonNameSvg = commonNameLines.map((line, i) => 
      `<text x="24" y="${bodyY + 42 + (i * 42)}" font-family="${FONT_FAMILY}" font-size="36" font-weight="bold" fill="white">${escapeXml(line)}</text>`
    ).join('\n        ');
    
    // Calculate where scientific name should go after common name
    const scientificNameY = bodyY + 42 + (commonNameLines.length * 42) + 12;
    
    // Build subspecies section if valid
    const subspeciesY = scientificNameY + 45;
    const subspeciesSvg = hasValidSubspecies ? `
        <!-- Subspecies section -->
        <text x="24" y="${subspeciesY}" font-family="${FONT_FAMILY}" font-size="13" fill="#888888" font-weight="bold" letter-spacing="1">
          SUBSPECIES
        </text>
        <text x="24" y="${subspeciesY + 26}" font-family="${FONT_FAMILY}" font-size="20" font-style="italic" fill="#aaaaaa">
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
        <line x1="24" y1="${headerHeight - 8}" x2="${textPanelWidth - 24}" y2="${headerHeight - 8}" stroke="#333333" stroke-width="1"/>
        
        <!-- BODY: Species Info -->
        ${commonNameSvg}
        <text x="24" y="${scientificNameY}" font-family="${FONT_FAMILY}" font-size="24" font-style="italic" fill="#bbbbbb">
          ${escapeXml(scientificName)}
        </text>
        ${subspeciesSvg}
      </svg>
    `;
    
    const textPanel = await sharp(Buffer.from(textSvg))
      .png()
      .toBuffer();
    
    // Composite the images side by side with high quality output
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
      .jpeg({ 
        quality: 95, // High quality (was 90)
        chromaSubsampling: '4:4:4' // No chroma subsampling for best quality
      })
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
