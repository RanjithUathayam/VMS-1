export type UserRole = 'admin' | 'manager' | 'vendor' | 'watchman' | 'inventory' | 'operator' | string;

export interface User {
  name: string;
  role: UserRole;
  permissions?: string[];   // screen keys granted by this role; populated on member login
  // Vendor-specific properties
  mobileNumber?: string;
  partyCode?: string;
  // Member-specific properties
  username?: string;
  // Session token issued by the backend on login — required on every subsequent API call
  token?: string;
}