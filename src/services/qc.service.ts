import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';
import { AuthService } from './auth.service';
import { QcInspection, QcListFilter, QcMeta, QcParty, QcPhoto, QcSourceDoc, QcSummary } from '../models/qc.model';

interface ApiResult<T> { status: number; message?: string; data: T; }

@Injectable({ providedIn: 'root' })
export class QcService {
    private http = inject(HttpClient);
    private api = environment.apiUrl + '/qc';
    private auth = inject(AuthService);
    private metaCache: Promise<QcMeta> | null = null;
    private metaToken: string | null = null;

    /** Dropdowns, defect checklist and the caller's QC permissions (cached per login session). */
    getMeta(): Promise<QcMeta> {
        const token = this.auth.getToken();
        if (!this.metaCache || this.metaToken !== token) {
            this.metaToken = token;
            this.metaCache = firstValueFrom(this.http.get<ApiResult<QcMeta>>(`${this.api}/meta`))
                .then(r => r.data)
                .catch(err => { this.metaCache = null; throw err; });
        }
        return this.metaCache;
    }

    getParties(): Promise<QcParty[]> {
        return firstValueFrom(this.http.get<ApiResult<QcParty[]>>(`${this.api}/parties`)).then(r => r.data || []);
    }

    /** Documents from [@ASRS_Transaction] @type = 'Binning' for a supplier, grouped by DocNum. */
    getDocuments(docType: string, partyCode: string): Promise<QcSourceDoc[]> {
        const q = `docType=${encodeURIComponent(docType)}&partyCode=${encodeURIComponent(partyCode)}`;
        return firstValueFrom(this.http.get<ApiResult<QcSourceDoc[]>>(`${this.api}/documents?${q}`)).then(r => r.data || []);
    }

    list(filter: QcListFilter): Promise<{ data: QcInspection[]; total: number; summary: QcSummary }> {
        return firstValueFrom(this.http.post<any>(`${this.api}/list`, filter));
    }

    getDetail(id: number): Promise<QcInspection> {
        return firstValueFrom(this.http.get<ApiResult<QcInspection>>(`${this.api}/detail/${id}`)).then(r => r.data);
    }

    save(payload: any): Promise<{ message: string; data: QcInspection; warnings?: string[]; duplicate?: boolean }> {
        return firstValueFrom(this.http.post<any>(`${this.api}/save`, payload));
    }

    decide(id: number, decision: 'APPROVE' | 'REJECT', remarks: string, rowVersion: string | null): Promise<{ message: string; data: QcInspection }> {
        return firstValueFrom(this.http.post<any>(`${this.api}/approve/${id}`, { decision, remarks, rowVersion }));
    }

    deleteDraft(id: number): Promise<{ message: string }> {
        return firstValueFrom(this.http.post<any>(`${this.api}/delete/${id}`, {}));
    }

    getPhotos(id: number): Promise<QcPhoto[]> {
        return firstValueFrom(this.http.get<ApiResult<QcPhoto[]>>(`${this.api}/photos/${id}`)).then(r => r.data || []);
    }

    addPhoto(id: number, caption: string, dataUrl: string): Promise<{ message: string; data: QcPhoto }> {
        return firstValueFrom(this.http.post<any>(`${this.api}/photos/${id}`, { caption, dataUrl }));
    }

    deletePhoto(photoId: number): Promise<{ message: string }> {
        return firstValueFrom(this.http.post<any>(`${this.api}/photos/delete/${photoId}`, {}));
    }
}

/** Extracts the server's message (and error list) from an HttpErrorResponse. */
export function apiError(err: any, fallback = 'Something went wrong. Please try again.'): { message: string; errors: string[] } {
    if (err?.status === 0) return { message: 'Cannot reach the server. Please check your connection.', errors: [] };
    const body = err?.error;
    return {
        message: (typeof body?.message === 'string' && body.message) || fallback,
        errors: Array.isArray(body?.errors) ? body.errors : [],
    };
}
