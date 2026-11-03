'use strict';
/* Reference data: ISO 3 codes and display names for the 55 AU Member States.
 * This is fixed reference data, not a user mapping. Keys are the REDCap country names in the data dictionary.
 * The dictionary supplies the numeric code and the Regional Collaborating Centre; this file only adds ISO 3. */
const ISO3 = {
  'Algeria': 'DZA', 'Angola': 'AGO', 'Benin': 'BEN', 'Botswana': 'BWA', 'Burkina Faso': 'BFA', 'Burundi': 'BDI', 'Cabo Verde': 'CPV',
  'Cameroon': 'CMR', 'Central African Republic': 'CAF', 'Chad': 'TCD', 'Comoros': 'COM', 'Congo (Republic of)': 'COG',
  "Côte d'Ivoire": 'CIV', 'Democratic Republic of Congo': 'COD', 'Djibouti': 'DJI', 'Egypt': 'EGY', 'Equatorial Guinea': 'GNQ',
  'Eritrea': 'ERI', 'Eswatini': 'SWZ', 'Ethiopia': 'ETH', 'Gabon': 'GAB', 'Gambia': 'GMB', 'Ghana': 'GHA', 'Guinea': 'GIN',
  'Guinea-Bissau': 'GNB', 'Kenya': 'KEN', 'Lesotho': 'LSO', 'Liberia': 'LBR', 'Libya': 'LBY', 'Madagascar': 'MDG', 'Malawi': 'MWI',
  'Mali': 'MLI', 'Mauritania': 'MRT', 'Mauritius': 'MUS', 'Morocco': 'MAR', 'Mozambique': 'MOZ', 'Namibia': 'NAM', 'Niger': 'NER',
  'Nigeria': 'NGA', 'Rwanda': 'RWA', 'Sahrawi Arab Democratic Republic': 'ESH', 'São Tomé and Príncipe': 'STP', 'Senegal': 'SEN',
  'Seychelles': 'SYC', 'Sierra Leone': 'SLE', 'Somalia': 'SOM', 'South Africa': 'ZAF', 'South Sudan': 'SSD', 'Sudan': 'SDN',
  'Tanzania': 'TZA', 'Togo': 'TGO', 'Tunisia': 'TUN', 'Uganda': 'UGA', 'Zambia': 'ZMB', 'Zimbabwe': 'ZWE'
};
/* Display names used by the dashboard where they differ from the REDCap choice label. */
const DISPLAY = { 'Congo (Republic of)': 'Congo', 'Democratic Republic of Congo': 'DR Congo', 'Sahrawi Arab Democratic Republic': 'Sahrawi Republic' };
/* RCC label in the dictionary -> region name used by the dashboard map and filters. */
const REGION = { Central: 'Central', Eastern: 'East', Northern: 'North', Southern: 'Southern', Western: 'West' };
module.exports = { ISO3, DISPLAY, REGION };
