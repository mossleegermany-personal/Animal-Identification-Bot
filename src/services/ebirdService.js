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

module.exports = {
  getEBirdSpeciesCode,
  getEBirdUrl
};
