import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';

export interface AppUser {
    Id:          number;
    Username:    string;
    FullName:    string;
    PhoneNumber: string;
    Email:       string;
    Role:        string;
    IsActive:    boolean;
    CreatedAt:   string;
}

export interface CreateUserPayload {
    username:    string;
    fullName:    string;
    phoneNumber: string;
    email:       string;
    password:    string;
    role:        string;
    isActive:    boolean;
}

export interface UpdateUserPayload {
    fullName:    string;
    phoneNumber: string;
    email:       string;
    role:        string;
    isActive:    boolean;
}

@Injectable({ providedIn: 'root' })
export class UserManagementService {
    private api = environment.apiUrl + '/users';

    constructor(private http: HttpClient) {}

    listUsers(): Promise<any> {
        return firstValueFrom(this.http.get(`${this.api}/list`));
    }

    createUser(payload: CreateUserPayload): Promise<any> {
        return firstValueFrom(this.http.post(`${this.api}/create`, payload));
    }

    updateUser(id: number, payload: UpdateUserPayload): Promise<any> {
        return firstValueFrom(this.http.put(`${this.api}/update/${id}`, payload));
    }

    toggleStatus(id: number, isActive: boolean): Promise<any> {
        return firstValueFrom(this.http.put(`${this.api}/toggle-status/${id}`, { isActive }));
    }

    resetPassword(id: number, newPassword: string): Promise<any> {
        return firstValueFrom(this.http.put(`${this.api}/reset-password/${id}`, { newPassword }));
    }
}
