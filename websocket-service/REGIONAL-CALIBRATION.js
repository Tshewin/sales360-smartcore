// ═══════════════════════════════════════════════════════════
// SALES360 REGIONAL CALIBRATION MODULE
// Adapts conversation style based on prospect's region + persona
// ═══════════════════════════════════════════════════════════

/**
 * Regional communication styles for Nigeria, UK, and UAE
 * Based on 15 years of cross-cultural sales experience
 */

const REGIONAL_STYLES = {
  Nigeria: {
    tone: 'warm_energetic',
    formality: 'casual_to_formal', // Varies by age
    moneyLanguage: 'direct', // "make money", "build wealth"
    timeRespect: 'flexible', // Conversations can run longer
    socialProof: 'community', // "Many Nigerian traders..."
    followUpSpeed: 'fast', // 1-2 hours
    communicationChannel: 'whatsapp_first',
    rapportBuilding: 'high', // Extra warmth needed
    
    // Language patterns (NO PIDGIN — clean English only)
    greetings: {
      young_male: ['Hey', 'Hi', 'What\'s up'],
      young_female: ['Hi', 'Hey', 'Good to connect'],
      professional: ['Good morning', 'Good afternoon', 'Hello'],
      senior: ['Good morning Sir', 'Good afternoon Ma', 'Good day Chief']
    },
    
    phrases: {
      rapport: [
        'I totally get that',
        'That makes a lot of sense',
        'I hear you on that',
        'Fair point'
      ],
      urgency: [
        'Let me ask you this',
        'Here\'s the thing',
        'Real talk',
        'Between you and me'
      ],
      respect: [
        'Sir', 'Ma', 'Chief' // For 45+ only
      ]
    },
    
    dreamAmplification: {
      currency: '₦',
      amounts: {
        entry: '50,000-100,000',
        target: '500,000',
        aspirational: '2,000,000'
      },
      desires: {
        young_male: ['new phone', 'laptop', 'nice clothes', 'impress someone special', 'support family'],
        young_female: ['financial independence', 'travel', 'nice things', 'help family', 'start a business'],
        professional: ['extra income', 'holiday', 'new car', 'investment property', 'children\'s education'],
        senior: ['retirement security', 'legacy for children', 'investment growth', 'passive income']
      }
    }
  },

  UK: {
    tone: 'professional_friendly',
    formality: 'measured', // Not too casual
    moneyLanguage: 'understated', // "financial goals", "portfolio growth"
    timeRespect: 'high', // "I know you're busy"
    socialProof: 'regulation', // "FCA-regulated"
    followUpSpeed: 'standard', // 24-48 hours
    communicationChannel: 'email_first',
    rapportBuilding: 'moderate', // Professional warmth
    
    greetings: {
      young_male: ['Hi', 'Hello', 'Good to speak with you'],
      young_female: ['Hi', 'Hello', 'Thanks for connecting'],
      professional: ['Good morning', 'Good afternoon', 'Hello'],
      senior: ['Good morning', 'Good afternoon', 'Mr./Ms. [Last Name]']
    },
    
    phrases: {
      rapport: [
        'I understand',
        'That makes sense',
        'Fair enough',
        'I appreciate that'
      ],
      urgency: [
        'Here\'s the thing',
        'Let me be straight with you',
        'The reality is',
        'What I\'ve found is'
      ],
      respect: [
        'Mr.', 'Ms.', 'Dr.' // Always use title until invited otherwise
      ]
    },
    
    dreamAmplification: {
      currency: '£',
      amounts: {
        entry: '500-1,000',
        target: '5,000',
        aspirational: '20,000'
      },
      desires: {
        young_male: ['travel', 'deposit for flat', 'career development', 'financial freedom', 'investments'],
        young_female: ['holiday', 'savings cushion', 'financial independence', 'property', 'security'],
        professional: ['mortgage deposit', 'children\'s university fund', 'early retirement', 'investment portfolio'],
        senior: ['retirement income', 'wealth preservation', 'legacy planning', 'grandchildren\'s future']
      }
    }
  },

  UAE: {
    tone: 'confident_premium',
    formality: 'formal_to_casual', // Start formal, adjust based on cues
    moneyLanguage: 'results_driven', // "ROI", "wealth management", "portfolio optimization"
    timeRespect: 'very_high', // "I respect your time"
    socialProof: 'exclusivity', // "Premium tier", "VIP access"
    followUpSpeed: 'fast', // 2-4 hours
    communicationChannel: 'whatsapp_email_both',
    rapportBuilding: 'status_aware', // Match their level
    
    greetings: {
      young_male: ['Hello', 'Good morning', 'Thanks for connecting'],
      young_female: ['Good morning', 'Hello', 'Thank you for your time'],
      professional: ['Good morning', 'Good afternoon', 'Mr./Ms. [Last Name]'],
      senior: ['Good morning Mr./Sheikh [Last Name]', 'Good afternoon']
    },
    
    phrases: {
      rapport: [
        'I appreciate that',
        'That\'s a fair point',
        'I understand',
        'Absolutely'
      ],
      urgency: [
        'Given your portfolio size',
        'For someone at your level',
        'Premium clients like yourself',
        'This opportunity is exclusive'
      ],
      respect: [
        'Mr.', 'Ms.', 'Sheikh', 'Dr.' // Always formal until relationship established
      ]
    },
    
    dreamAmplification: {
      currency: 'AED',
      amounts: {
        entry: '5,000-10,000',
        target: '50,000',
        aspirational: '200,000'
      },
      desires: {
        young_male: ['luxury car', 'property investment', 'business expansion', 'portfolio growth', 'wealth building'],
        young_female: ['financial independence', 'investment portfolio', 'business growth', 'property', 'luxury lifestyle'],
        professional: ['wealth diversification', 'property portfolio', 'business investments', 'early retirement', 'legacy building'],
        senior: ['wealth preservation', 'family legacy', 'portfolio optimization', 'passive income streams']
      }
    }
  }
};

/**
 * Determine persona category based on age and gender
 */
function getPersonaCategory(age, gender) {
  if (age < 30) {
    return gender.toLowerCase() === 'female' ? 'young_female' : 'young_male';
  } else if (age < 45) {
    return 'professional';
  } else {
    return 'senior';
  }
}

/**
 * Get appropriate greeting based on region, age, and gender
 */
function getGreeting(region, age, gender, name) {
  const style = REGIONAL_STYLES[region];
  if (!style) return `Hi ${name}`;
  
  const persona = getPersonaCategory(age, gender);
  const greetingOptions = style.greetings[persona] || style.greetings.professional;
  
  // Pick first greeting (can randomize later if needed)
  const greeting = greetingOptions[0];
  
  // For senior prospects in Nigeria, add title
  if (region === 'Nigeria' && persona === 'senior') {
    const title = gender.toLowerCase() === 'female' ? 'Ma' : 'Sir';
    return `${greeting} ${title}, ${name}`;
  }
  
  return `${greeting} ${name}`;
}

/**
 * Get rapport-building phrase based on region
 */
function getRapportPhrase(region) {
  const style = REGIONAL_STYLES[region];
  if (!style) return 'I understand';
  
  const phrases = style.phrases.rapport;
  return phrases[Math.floor(Math.random() * phrases.length)];
}

/**
 * Get urgency-building phrase based on region
 */
function getUrgencyPhrase(region) {
  const style = REGIONAL_STYLES[region];
  if (!style) return 'Here\'s the thing';
  
  const phrases = style.phrases.urgency;
  return phrases[Math.floor(Math.random() * phrases.length)];
}

/**
 * Get dream amplification examples based on region, age, gender
 */
function getDreamContext(region, age, gender) {
  const style = REGIONAL_STYLES[region];
  if (!style) return null;
  
  const persona = getPersonaCategory(age, gender);
  const dreams = style.dreamAmplification;
  
  return {
    currency: dreams.currency,
    targetAmount: dreams.amounts.target,
    desires: dreams.desires[persona] || dreams.desires.professional
  };
}

/**
 * Get regional style guidelines for prompt construction
 */
function getRegionalGuidelines(region) {
  const style = REGIONAL_STYLES[region];
  if (!style) return '';
  
  let guidelines = `\n**REGIONAL STYLE: ${region.toUpperCase()}**\n`;
  guidelines += `- Tone: ${style.tone.replace(/_/g, ' ')}\n`;
  guidelines += `- Money Language: ${style.moneyLanguage} (`;
  
  if (style.moneyLanguage === 'direct') {
    guidelines += 'use "make money", "build wealth", "earn profit")\n';
  } else if (style.moneyLanguage === 'understated') {
    guidelines += 'use "financial goals", "portfolio growth", "wealth building")\n';
  } else {
    guidelines += 'use "ROI", "returns", "portfolio optimization", "wealth management")\n';
  }
  
  guidelines += `- Rapport Building: ${style.rapportBuilding}\n`;
  guidelines += `- Time Respect: ${style.timeRespect === 'high' || style.timeRespect === 'very_high' ? 'Acknowledge their time explicitly' : 'Natural flow OK'}\n`;
  
  return guidelines;
}

/**
 * Main function: Get calibrated style settings for a prospect
 */
function getCalibratedStyle(region, age, gender, name) {
  return {
    greeting: getGreeting(region, age, gender, name),
    rapportPhrase: getRapportPhrase(region),
    urgencyPhrase: getUrgencyPhrase(region),
    dreamContext: getDreamContext(region, age, gender),
    guidelines: getRegionalGuidelines(region),
    style: REGIONAL_STYLES[region] || REGIONAL_STYLES.UK // Default to UK if region not found
  };
}

module.exports = {
  REGIONAL_STYLES,
  getPersonaCategory,
  getGreeting,
  getRapportPhrase,
  getUrgencyPhrase,
  getDreamContext,
  getRegionalGuidelines,
  getCalibratedStyle
};
