// Species Photo Service - Get reference images from iNaturalist

const INATURALIST_API = 'https://api.inaturalist.org/v1';

/**
 * Get photo from iNaturalist
 */
async function getINaturalistPhoto(scientificName) {
  try {
    const parts = scientificName.split(' ');
    const genus = parts[0];
    const species = parts[1] || '';
    const binomialName = `${genus} ${species}`.trim();
    
    // Try with binomial name (genus + species only, no subspecies)
    const url = `${INATURALIST_API}/taxa?q=${encodeURIComponent(binomialName)}&per_page=20`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      // First, try exact match on binomial
      for (const taxon of data.results) {
        const taxonParts = (taxon.name || '').split(' ');
        const taxonBinomial = `${taxonParts[0]} ${taxonParts[1] || ''}`.trim().toLowerCase();
        
        if (taxonBinomial === binomialName.toLowerCase() && taxon.default_photo) {
          let photoUrl = taxon.default_photo.medium_url || 
                         taxon.default_photo.small_url ||
                         taxon.default_photo.square_url;
          
          if (photoUrl) {
            photoUrl = photoUrl.replace('square', 'medium').replace('small', 'medium');
          }
          
          console.log(`   ✅ iNaturalist photo found: ${taxon.name}`);
          return {
            found: true,
            photoUrl: photoUrl,
            taxonId: taxon.id,
            name: taxon.name
          };
        }
      }
      
      // Second pass: genus match with photo
      for (const taxon of data.results) {
        const taxonGenus = (taxon.name?.split(' ')[0] || '').toLowerCase();
        
        if (taxonGenus === genus.toLowerCase() && taxon.default_photo) {
          let photoUrl = taxon.default_photo.medium_url || 
                         taxon.default_photo.small_url ||
                         taxon.default_photo.square_url;
          
          if (photoUrl) {
            photoUrl = photoUrl.replace('square', 'medium').replace('small', 'medium');
          }
          
          console.log(`   ✅ iNaturalist photo found (genus match): ${taxon.name}`);
          return {
            found: true,
            photoUrl: photoUrl,
            taxonId: taxon.id,
            name: taxon.name
          };
        }
      }
    }
    return { found: false };
  } catch (error) {
    console.error('iNaturalist error:', error.message);
    return { found: false };
  }
}

/**
 * Get species photo from iNaturalist
 */
async function getSpeciesPhoto(scientificName, subspeciesName = null) {
  // Extract binomial name (genus + species only, ignore subspecies)
  const parts = scientificName.split(' ');
  const binomialName = `${parts[0]} ${parts[1] || ''}`.trim();
  
  console.log(`📷 Getting photo for "${binomialName}"...`);
  console.log('   🔍 Looking up iNaturalist...');
  
  const iNatPhoto = await getINaturalistPhoto(binomialName);
  
  if (iNatPhoto.found && iNatPhoto.photoUrl) {
    console.log('   ✅ Using iNaturalist photo');
    return {
      found: true,
      photoUrl: iNatPhoto.photoUrl,
      source: 'iNaturalist',
      taxonId: iNatPhoto.taxonId,
      taxonName: iNatPhoto.name
    };
  }
  
  console.log('   ❌ No photo found');
  return { found: false, taxonId: null, taxonName: null };
}

module.exports = {
  getSpeciesPhoto
};
