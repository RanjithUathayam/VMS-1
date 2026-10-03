import { Injectable, signal, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { User } from '../models/user.model';
import { firstValueFrom } from 'rxjs';
import { environment } from "../environments/environment"

@Injectable({
    providedIn: 'root'
})
export class AuthService {
    // FIX: Explicitly type `http` as HttpClient to avoid type inference errors where it was considered 'unknown'.
    private http: HttpClient = inject(HttpClient);
    private apiUrl = environment.apiUrl
    currentUser = signal<User | null>(null);

    constructor() {
        // Persist login state across reloads (for development convenience)
        const storedUser = localStorage.getItem('currentUser');
        if (storedUser) {
            try {
                const user: User = JSON.parse(storedUser);
                if (this.isTokenValid(user.token)) {
                    this.currentUser.set(user);
                } else {
                    // Expired, or a pre-JWT session with no token — every API call would 401.
                    localStorage.removeItem('currentUser');
                }
            } catch {
                localStorage.removeItem('currentUser');
            }
        }
    }

    /** True if the JWT exists and its `exp` claim is still in the future. */
    private isTokenValid(token: string | undefined): boolean {
        if (!token) return false;
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return typeof payload.exp !== 'number' || payload.exp * 1000 > Date.now();
        } catch {
            return false;
        }
    }

    private handleLoginSuccess(user: User) {
        this.currentUser.set(user);
        localStorage.setItem('currentUser', JSON.stringify(user));
    }

    /** Bearer token issued at login — attached to every API request by the auth interceptor. */
    getToken(): string | null {
        return this.currentUser()?.token || null;
    }

    /** Logs the failure and returns the server's message (e.g. "OTP has expired", rate-limit notice). */
    private handleLoginError(error: unknown, fallback: string): string {
        if (error instanceof HttpErrorResponse) {
            const serverMessage = (error.error as any)?.message;
            console.log(`Login failed with status ${error.status}:`, serverMessage || error.message);
            if (error.status === 0) return 'Cannot reach the server. Please check your connection.';
            return typeof serverMessage === 'string' && serverMessage ? serverMessage : fallback;
        }
        console.log('Login failed with an unexpected error:', error);
        return fallback;
    }

    async sendOtp(mobileNumber: string): Promise<{ success: boolean; message: string }> {
        try {
           let result:any = await firstValueFrom(this.http.post<{ message: string }>(`${this.apiUrl}/auth/send-otp`, { mobileNumber }));
           return result
        } catch (error) {
            return { success: false, message: this.handleLoginError(error, 'Failed to send OTP due to a server error.') };
        }
    }

    async loginVendor(mobileNumber: string, otp: string): Promise<{ success: boolean; message?: string }> {
        try {
            const user = await firstValueFrom(this.http.post<User>(`${this.apiUrl}/auth/login/vendor`, { mobileNumber, otp }));
            this.handleLoginSuccess(user);
            return { success: true };
        } catch (error) {
            return { success: false, message: this.handleLoginError(error, 'Invalid OTP or vendor not found.') };
        }
    }

    async loginMember(username: string, password: string): Promise<{ success: boolean; message?: string }> {
        try {
            const user = await firstValueFrom(this.http.post<User>(`${this.apiUrl}/auth/login/member`, { username, password }));
            this.handleLoginSuccess(user);
            return { success: true };
        } catch (error) {
            return { success: false, message: this.handleLoginError(error, 'Invalid username or password.') };
        }
    }

    /** Returns true if the current user has access to the given screen key. */
    hasPermission(screen: string): boolean {
        const user = this.currentUser();
        if (!user) return false;
        const perms = user.permissions;
        if (Array.isArray(perms) && perms.length > 0) {
            return perms.includes(screen);
        }
        // Fallback for sessions without permissions (vendor OTP login or old localStorage)
        return this.defaultPermissions(user.role, screen);
    }

    private defaultPermissions(role: string, screen: string): boolean {
        const map: Record<string, string[]> = {
            admin:     ['dashBoard','vendor','warehouse','gate','partyBinMaster','joStatus','userManagement'],
            manager:   ['dashBoard','warehouse','joStatus'],
            vendor:    ['vendor','joStatus'],
            watchman:  ['dashBoard','gate'],
            inventory: ['vendor','partyBinMaster','joStatus'],
            operator:  ['vendor'],
        };
        return (map[role] || []).includes(screen);
    }

    async changePassword(username: string, currentPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> {
        try {
            const res: any = await firstValueFrom(
                this.http.put(`${this.apiUrl}/auth/change-password`, { username, currentPassword, newPassword })
            );
            return { success: true, message: res?.message || 'Password changed.' };
        } catch (error: any) {
            const msg = error?.error?.message || error?.message || 'Failed to change password.';
            return { success: false, message: msg };
        }
    }

    logout(): void {
        this.currentUser.set(null);
        localStorage.removeItem('currentUser');
    }
}