// GBIF (Global Biodiversity Information Facility) API integration
// GBIF has 2.5+ billion occurrence records - the world's largest biodiversity database

const GBIF_API = 'https://api.gbif.org/v1';
const INATURALIST_API = 'https://api.inaturalist.org/v1';

/**
 * Get photo from iNaturalist for a species
 */
async function getINaturalistPhoto(scientificName) {
  try {
    const speciesName = scientificName.split(' ').slice(0, 2).join(' ');
    const url = `${INATURALIST_API}/taxa?q=${encodeURIComponent(speciesName)}&per_page=1`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      const taxon = data.results[0];
      return {
        photoUrl: taxon.default_photo?.medium_url || taxon.default_photo?.square_url,
        observationsCount: taxon.observations_count,
        wikipediaUrl: taxon.wikipedia_url
      };
    }
    return null;
  } catch (error) {
    console.error('iNaturalist photo error:', error.message);
    return null;
  }
}

/**
 * Simple geocoding using Nominatim (free)
 */
async function geocodeLocation(locationName) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'WildlifeIDBot/1.0' }
    });
    const data = await response.json();
    
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        displayName: data[0].display_name
      };
    }
    return null;
  } catch (error) {
    console.error('Geocoding error:', error.message);
    return null;
  }
}

/**
 * Get species info from GBIF by scientific name
 */
async function getSpeciesInfo(scientificName) {
  try {
    const speciesName = scientificName.split(' ').slice(0, 2).join(' ');
    const url = `${GBIF_API}/species/match?name=${encodeURIComponent(speciesName)}&verbose=true`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.usageKey) {
      return {
        found: true,
        key: data.usageKey,
        scientificName: data.scientificName,
        canonicalName: data.canonicalName,
        rank: data.rank,
        status: data.status,
        confidence: data.confidence,
        kingdom: data.kingdom,
        phylum: data.phylum,
        class: data.class,
        order: data.order,
        family: data.family,
        genus: data.genus,
        species: data.species
      };
    }
    return { found: false };
  } catch (error) {
    console.error('GBIF species lookup error:', error.message);
    return { found: false, error: error.message };
  }
}

/**
 * Get all subspecies for a species from GBIF
 */
async function getSubspecies(speciesKey) {
  try {
    const url = `${GBIF_API}/species/${speciesKey}/children?limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.results) {
      return data.results
        .filter(r => r.rank === 'SUBSPECIES' || r.rank === 'VARIETY')
        .map(r => ({
          name: r.canonicalName || r.scientificName,
          rank: r.rank,
          key: r.key,
          status: r.taxonomicStatus
        }));
    }
    return [];
  } catch (error) {
    console.error('GBIF subspecies error:', error.message);
    return [];
  }
}

/**
 * Check if species occurs at a specific location using GBIF occurrence data
 */
async function checkOccurrencesAtLocation(speciesKey, coords) {
  try {
    // Search within ~100km of location
    const url = `${GBIF_API}/occurrence/search?taxonKey=${speciesKey}&decimalLatitude=${coords.lat - 1},${coords.lat + 1}&decimalLongitude=${coords.lng - 1},${coords.lng + 1}&limit=100`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    return {
      count: data.count || 0,
      hasRecords: data.count > 0,
      recentRecords: data.results?.slice(0, 5).map(r => ({
        date: r.eventDate,
        country: r.country,
        locality: r.locality,
        recordedBy: r.recordedBy
      })) || []
    };
  } catch (error) {
    console.error('GBIF occurrence error:', error.message);
    return { count: 0, hasRecords: false };
  }
}

/**
 * Full verification of Gemini result using GBIF
 */
async function verifyWithGBIF(geminiResult, location = null) {
  console.log('\n🌍 GBIF: Verifying identification...');
  
  const result = {
    verified: false,
    matches: false,
    geminiName: geminiResult.scientificName,
    gbifName: null,
    species: null,
    subspeciesList: [],
    locationVerified: false,
    occurrences: null
  };
  
  if (!geminiResult.identified || !geminiResult.scientificName) {
    return result;
  }
  
  // Step 1: Look up species in GBIF
  const speciesInfo = await getSpeciesInfo(geminiResult.scientificName);
  
  if (!speciesInfo.found) {
    console.log('   ❌ Species not found in GBIF');
    return result;
  }
  
  console.log(`   ✅ Found: ${speciesInfo.canonicalName} (${speciesInfo.rank})`);
  result.verified = true;
  result.species = speciesInfo;
  result.gbifName = speciesInfo.canonicalName;
  
  // Check if names match
  const geminiBase = geminiResult.scientificName.toLowerCase().split(' ').slice(0, 2).join(' ');
  const gbifBase = speciesInfo.canonicalName?.toLowerCase().split(' ').slice(0, 2).join(' ');
  result.matches = geminiBase === gbifBase;
  
  if (!result.matches) {
    console.log(`   ⚠️ Name mismatch: Gemini="${geminiResult.scientificName}" vs GBIF="${speciesInfo.canonicalName}"`);
  }
  
  // Step 2: Get subspecies list
  const subspecies = await getSubspecies(speciesInfo.key);
  result.subspeciesList = subspecies;
  if (subspecies.length > 0) {
    console.log(`   📋 Found ${subspecies.length} subspecies in GBIF`);
  }
  
  // Step 3: Verify location if provided
  if (location) {
    const coords = await geocodeLocation(location);
    if (coords) {
      console.log(`   📍 Checking occurrences near ${coords.displayName?.split(',')[0] || location}...`);
      const occurrences = await checkOccurrencesAtLocation(speciesInfo.key, coords);
      result.occurrences = occurrences;
      result.locationVerified = occurrences.hasRecords;
      
      if (occurrences.hasRecords) {
        console.log(`   ✅ ${occurrences.count} records found in this area`);
      } else {
        console.log(`   ⚠️ No GBIF records in this exact area (may still be present)`);
      }
    }
  }
  
  return result;
}

/**
 * Format GBIF result for Telegram display
 */
function formatGBIFResult(gbifResult, location = null) {
  let text = '\n';
  
  if (!gbifResult.verified) {
    text += `🌍 *GBIF:* ❌ Species not found in database\n`;
    return { text, verified: false, matches: false };
  }
  
  const sp = gbifResult.species;
  
  // Show match or mismatch
  if (gbifResult.matches) {
    text += `🌍 *GBIF:* ✅ Confirmed - _${gbifResult.gbifName}_\n`;
  } else {
    text += `🌍 *GBIF:* ⚠️ Different result\n`;
    text += `• Gemini: _${gbifResult.geminiName}_\n`;
    text += `• GBIF: _${gbifResult.gbifName}_\n`;
  }
  
  text += `• Match confidence: ${sp.confidence}%\n`;
  
  // Location verification
  if (location && gbifResult.occurrences) {
    if (gbifResult.locationVerified) {
      text += `• 📍 Location: ✅ ${gbifResult.occurrences.count.toLocaleString()} records near ${location}\n`;
    } else {
      text += `• 📍 Location: ⚠️ No records near ${location}\n`;
    }
  }
  
  // Subspecies list
  if (gbifResult.subspeciesList.length > 0) {
    text += `\n📋 *Known Subspecies (${gbifResult.subspeciesList.length}):*\n`;
    gbifResult.subspeciesList.slice(0, 8).forEach(sub => {
      text += `  • _${sub.name}_\n`;
    });
    if (gbifResult.subspeciesList.length > 8) {
      text += `  • ... and ${gbifResult.subspeciesList.length - 8} more\n`;
    }
  }
  
  return {
    text,
    verified: true,
    matches: gbifResult.matches,
    subspeciesCount: gbifResult.subspeciesList.length
  };
}

module.exports = {
  getSpeciesInfo,
  getSubspecies,
  checkOccurrencesAtLocation,
  verifyWithGBIF,
  formatGBIFResult,
  geocodeLocation
};
