import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';

export interface AppRole {
    Id:          number;
    RoleName:    string;
    DisplayName: string;
    Description: string;
    Permissions: string[];
    IsSystem:    boolean;
    CreatedAt:   string;
}

export interface AppScreen {
    key:   string;
    label: string;
}

export interface CreateRolePayload {
    roleName:    string;
    displayName: string;
    description: string;
    permissions: string[];
}

export interface UpdateRolePayload {
    displayName: string;
    description: string;
    permissions: string[];
}

@Injectable({ providedIn: 'root' })
export class RoleManagementService {
    private api = environment.apiUrl + '/roles';

    constructor(private http: HttpClient) {}

    listRoles(): Promise<any> {
        return firstValueFrom(this.http.get(`${this.api}/list`));
    }

    getScreens(): Promise<any> {
        return firstValueFrom(this.http.get(`${this.api}/screens`));
    }

    createRole(payload: CreateRolePayload): Promise<any> {
        return firstValueFrom(this.http.post(`${this.api}/create`, payload));
    }

    updateRole(id: number, payload: UpdateRolePayload): Promise<any> {
        return firstValueFrom(this.http.put(`${this.api}/update/${id}`, payload));
    }

    deleteRole(id: number): Promise<any> {
        return firstValueFrom(this.http.delete(`${this.api}/delete/${id}`));
    }
}
