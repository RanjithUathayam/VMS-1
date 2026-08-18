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
            this.currentUser.set(JSON.parse(storedUser));
        }
    }

    private handleLoginSuccess(user: User) {
        this.currentUser.set(user);
        localStorage.setItem('currentUser', JSON.stringify(user));
    }

    private handleLoginError(error: unknown) {
        if (error instanceof HttpErrorResponse) {
             // FIX: The type guard `instanceof HttpErrorResponse` should correctly narrow the type of `error`.
             // To resolve linter errors about accessing properties on an 'unknown' type, we explicitly cast the error
             // and handle message extraction more robustly.
             const httpError = error as HttpErrorResponse;
             const serverError = httpError.error;
             const message = (typeof serverError === 'object' && serverError && 'message' in serverError && typeof (serverError as any).message === 'string')
                ? (serverError as any).message
                : httpError.message;
             console.log(`Login failed with status ${httpError.status}:`, message);
        } else {
             console.log('Login failed with an unexpected error:', error);
        }
    }

    async sendOtp(mobileNumber: string): Promise<{ success: boolean; message: string }> {
        try {
           let result:any = await firstValueFrom(this.http.post<{ message: string }>(`${this.apiUrl}/auth/send-otp`, { mobileNumber }));
           return result
        } catch (error) {
            let message = 'An unknown error occurred.';
            if (error instanceof HttpErrorResponse) {
                const httpError = error as HttpErrorResponse;
                const serverError = httpError.error;
                message = (typeof serverError === 'object' && serverError && 'message' in serverError && typeof (serverError as any).message === 'string')
                    ? (serverError as any).message
                    : 'Failed to send OTP due to a server error.';
            }
            this.handleLoginError(error);
            return { success: false, message };
        }
    }

    async loginVendor(mobileNumber: string, otp: string): Promise<boolean> {
        try {
            const user = await firstValueFrom(this.http.post<User>(`${this.apiUrl}/auth/login/vendor`, { mobileNumber, otp }));
            if (user) {
                this.handleLoginSuccess(user);
                return true;
            }
            return false;
        } catch (error) {
            this.handleLoginError(error);
            return false;
        }
    }

    async loginMember(username: string, password: string): Promise<boolean> {
        try {
            const user = await firstValueFrom(this.http.post<User>(`${this.apiUrl}/auth/login/member`, { username, password }));
            if (user) {
                this.handleLoginSuccess(user);
                return true;
            }
            return false;
        } catch (error) {
            this.handleLoginError(error);
            return false;
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
            admin:     ['dashBoard','vendor','warehouse','gate','partyBinMaster','grnPushing','joStatus','userManagement'],
            manager:   ['dashBoard','warehouse','joStatus'],
            vendor:    ['vendor','joStatus'],
            watchman:  ['dashBoard','gate'],
            inventory: ['vendor','partyBinMaster','grnPushing'],
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