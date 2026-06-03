export interface LabelValue {
  label: string;
  value: string;
}

export interface MongoGeoPoint {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

export interface MongoOfficeHourDay {
  id: number;
  label: string;
  officeHoursFrom: string;
  officeHoursTo: string;
  additionalOfficeHoursFrom: string;
  additionalOfficeHoursTo: string;
}

export interface MongoOfficeHour {
  _id: unknown;
  label: string;
  institutionId: string;
  days: MongoOfficeHourDay[];
}

export interface MongoLocation {
  _id: unknown;
  name?: string;
  street?: string;
  city?: string;
  postcode?: number;
  province?: string;
  district?: string;
  location?: MongoGeoPoint;
  formatedAddress?: string;
  accessibility?: string;
  accessibilityComment?: string;
  email?: string;
  phone?: string;
  institutionId?: string;
  landWideValid?: boolean;
  officeHours?: LabelValue[];
}

export interface MongoOffer {
  _id: unknown;
  title: string;
  slug?: string;
  description?: string;
  descriptionPrint?: string;
  description2?: string;
  description3?: string;
  description4?: string;
  website?: string;
  costs?: string;
  costsComment?: string;
  modesOfContact?: string[];
  anonymousCounseling?: boolean;
  appointmentArrangement?: string;
  institutionId?: string;
  institutionName?: string;
  validFrom?: Date;
  validTo?: Date;
  releasedFrom?: string;
  releasedTime?: Date;
  locationProvinces?: string[];
  locationPostCodes?: number[];
  keyWords?: LabelValue[];
  targetGroups?: LabelValue[];
  categories?: LabelValue[];
  locationsIds?: LabelValue[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface GeocodedLocation {
  lat: number;
  lng: number;
  name: string;
  cleanQuery: string;
}

export interface NominatimResult {
  lat: string;
  lon: string;
  type: string;
  addresstype: string;
  display_name: string;
}

export interface SearchResultCategory {
  label: string;
  slug: string;
}

export interface SearchResultLocation {
  name: string;
  street: string;
  city: string;
  postcode: number;
  province: string;
  lat: number;
  lng: number;
  formatted_address: string;
}

export interface SearchResult {
  id: string;
  title: string;
  slug: string;
  institution_name: string;
  description: string;
  description_print: string;
  website: string;
  costs: string;
  modes_of_contact: string[];
  location_provinces: string[];
  location_post_codes: number[];
  keywords: string[];
  target_groups: string[];
  score: string;
  distance_km: string | null;
  categories: SearchResultCategory[] | null;
  locations: SearchResultLocation[] | null;
}

export interface SearchRequest {
  query: string;
  provinces?: string[];
  limit?: number;
}

export interface SearchResponse {
  query: string;
  location: { name: string; lat: number; lng: number } | null;
  results: SearchResult[];
}
