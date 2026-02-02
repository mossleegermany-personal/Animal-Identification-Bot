// eBird Service - Get species codes for eBird URLs

const EBIRD_API = 'https://api.ebird.org/v2';

// Cache the taxonomy to avoid repeated large downloads
let taxonomyCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get eBird taxonomy (cached)
 */
async function getEBirdTaxonomy() {
  const now = Date.now();
  
  // Return cached data if still valid
  if (taxonomyCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return taxonomyCache;
  }
  
  try {
    console.log('   📥 Downloading eBird taxonomy...');
    const url = `${EBIRD_API}/ref/taxonomy/ebird?fmt=json`;
    const response = await fetch(url, {
      headers: {
        'X-eBirdApiToken': process.env.EBIRD_API_KEY
      }
    });
    
    if (!response.ok) {
      console.log(`   ⚠️ eBird API returned ${response.status}`);
      return null;
    }
    
    taxonomyCache = await response.json();
    cacheTimestamp = now;
    console.log(`   ✅ Cached ${taxonomyCache.length} species`);
    return taxonomyCache;
  } catch (error) {
    console.error('eBird taxonomy error:', error.message);
    return null;
  }
}

/**
 * Get eBird species code from scientific name
 * eBird uses species codes like "bwppit1" for Blue-winged Pitta
 * URL format: https://ebird.org/species/bwppit1
 */
async function getEBirdSpeciesCode(scientificName) {
  try {
    // Use genus + species only (first two words)
    const nameParts = scientificName.split(' ');
    const genus = nameParts[0].toLowerCase();
    const species = (nameParts[1] || '').toLowerCase();
    const speciesName = `${nameParts[0]} ${nameParts[1] || ''}`.trim();
    
    console.log(`   🐦 Looking up eBird species code for "${speciesName}"...`);
    
    const taxonomy = await getEBirdTaxonomy();
    
    if (!taxonomy) {
      return { found: false };
    }
    
    // Find exact match by scientific name
    for (const bird of taxonomy) {
      const birdSciName = (bird.sciName || '').toLowerCase();
      const birdGenus = birdSciName.split(' ')[0];
      const birdSpecies = birdSciName.split(' ')[1] || '';
      
      // Match genus and species
      if (birdGenus === genus && birdSpecies === species) {
        console.log(`   ✅ eBird species code: ${bird.speciesCode} (${bird.comName})`);
        return {
          found: true,
          speciesCode: bird.speciesCode,
          commonName: bird.comName,
          scientificName: bird.sciName
        };
      }
    }
    
    console.log(`   ❌ No eBird species found for "${speciesName}"`);
    return { found: false };
    
  } catch (error) {
    console.error('eBird lookup error:', error.message);
    return { found: false };
  }
}

/**
 * Build eBird species URL from species code
 */
function getEBirdUrl(speciesCode) {
  if (!speciesCode) return null;
  return `https://ebird.org/species/${speciesCode}`;
}

/**
 * Verify bird identification with eBird taxonomy
 * Handles synonyms by also checking common name matches
 * Returns the correct species if found, or indicates mismatch
 */
async function verifyWithEBird(scientificName, commonName = null) {
  try {
    const nameParts = scientificName.split(' ');
    const genus = nameParts[0].toLowerCase();
    const species = (nameParts[1] || '').toLowerCase();
    const speciesName = `${nameParts[0]} ${nameParts[1] || ''}`.trim();
    
    console.log(`   🐦 eBird: Verifying "${speciesName}"${commonName ? ` (${commonName})` : ''}...`);
    
    const taxonomy = await getEBirdTaxonomy();
    
    if (!taxonomy) {
      return { verified: false, found: false };
    }
    
    // Find exact match by scientific name
    for (const bird of taxonomy) {
      const birdSciName = (bird.sciName || '').toLowerCase();
      const birdGenus = birdSciName.split(' ')[0];
      const birdSpecies = birdSciName.split(' ')[1] || '';
      
      // Match genus and species
      if (birdGenus === genus && birdSpecies === species) {
        console.log(`   ✅ eBird: Confirmed - ${bird.sciName} (${bird.comName})`);
        return {
          verified: true,
          found: true,
          matches: true,
          speciesCode: bird.speciesCode,
          commonName: bird.comName,
          scientificName: bird.sciName,
          eBirdName: bird.sciName
        };
      }
    }
    
    // Not found by scientific name - try matching by common name (handles synonyms)
    if (commonName) {
      const commonLower = commonName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
      console.log(`   🔍 eBird: Searching by common name "${commonName}"...`);
      
      for (const bird of taxonomy) {
        const birdComName = (bird.comName || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
        
        // Exact common name match
        if (birdComName === commonLower) {
          console.log(`   ✅ eBird: Found by common name - ${bird.sciName} (${bird.comName})`);
          return {
            verified: true,
            found: true,
            matches: false,  // Scientific name changed
            speciesCode: bird.speciesCode,
            commonName: bird.comName,
            scientificName: bird.sciName,
            eBirdName: bird.sciName,
            originalName: speciesName,
            nameUpdatedReason: 'matched by common name'
          };
        }
      }
      
      // Try partial common name match (e.g., "Golden Oriole" in "Eurasian Golden Oriole")
      for (const bird of taxonomy) {
        const birdComName = (bird.comName || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
        
        if (birdComName.includes(commonLower) || commonLower.includes(birdComName)) {
          console.log(`   📝 eBird: Partial common name match - ${bird.sciName} (${bird.comName})`);
          return {
            verified: true,
            found: true,
            matches: false,
            speciesCode: bird.speciesCode,
            commonName: bird.comName,
            scientificName: bird.sciName,
            eBirdName: bird.sciName,
            originalName: speciesName,
            nameUpdatedReason: 'partial common name match'
          };
        }
      }
    }
    
    // Still not found - try fuzzy match by genus
    console.log(`   ⚠️ eBird: Species "${speciesName}" not found, searching by genus...`);
    for (const bird of taxonomy) {
      const birdSciName = (bird.sciName || '').toLowerCase();
      const birdGenus = birdSciName.split(' ')[0];
      
      if (birdGenus === genus) {
        console.log(`   📝 eBird: Found same genus - ${bird.sciName} (${bird.comName})`);
        return {
          verified: true,
          found: true,
          matches: false,
          speciesCode: bird.speciesCode,
          commonName: bird.comName,
          scientificName: bird.sciName,
          eBirdName: bird.sciName,
          originalName: speciesName,
          nameUpdatedReason: 'same genus'
        };
      }
    }
    
    console.log(`   ❌ eBird: No match found for "${speciesName}"`);
    return { verified: false, found: false };
    
  } catch (error) {
    console.error('eBird verification error:', error.message);
    return { verified: false, found: false };
  }
}

module.exports = {
  getEBirdSpeciesCode,
  getEBirdUrl,
  verifyWithEBird
};
