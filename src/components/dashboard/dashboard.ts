import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgChartsModule } from 'ng2-charts';
import { interval, Subscription } from 'rxjs';
import { MaterialEntryService } from '../../services/material-entry.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, NgChartsModule],
  templateUrl: './dashboard.html'
})
export class DashboardComponent implements OnInit, OnDestroy {

    data: any[] = [];
    pagedData: any[] = [];
    refreshSub!: Subscription;
    private auth = inject(AuthService);

    totalEntries = 0;
    totalQty = 0;
    loading = false;
    errorMessage = '';

    filters = {
        fromDate: '',
        toDate: '',
        docType: 'All',
        status: 'All'
    }

    searchTerm = '';
    filteredList: any[] = []
    // pagination
    page = 1;
    pageSize = 10;
    totalPages = 0;

    /* ---------------- PIE CHART ---------------- */
    pieLabels: string[] = []
    pieData: number[] = []
    pieColors: string[] = [
        '#2563eb',
        '#16a34a',
        '#facc15',
        '#dc2626',
        '#7c3aed'
    ]

    pieOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'bottom' },
            tooltip: {
                callbacks: {
                    label: (ctx: any) => `${ctx.label}: ${ctx.raw}`
                }
            }
        }
    }

    /* ---------------- BAR CHART ---------------- */
    barLabels: string[] = [];
    barData: number[] = [];

    barOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                label: (ctx: any) => `Qty: ${ctx.raw}`
                }
            }
        },
        scales: {
            y: { beginAtZero: true }
        }
    };

    currentUser = this.auth.currentUser;

    private service = inject(MaterialEntryService);

    constructor(private cdr: ChangeDetectorRef) {}

    ngOnInit(): void {
        const now = new Date();
        this.filters.fromDate = new Date(now.getFullYear(),now.getMonth(),1).toISOString().slice(0, 10);
        this.filters.toDate = now.toISOString().slice(0, 10);

        // ✅ Load immediately
        this.load();

        // 🔁 Auto refresh every 60 sec
        this.refreshSub = interval(60000).subscribe(() => {
            this.load();
        });
    }

    ngOnDestroy(): void {
        this.refreshSub?.unsubscribe();
    }

    load(): void {
        // ✅ Normalize payload (VERY IMPORTANT)
        const payload = {
            fromDate: this.filters.fromDate || null,
            toDate: this.filters.toDate || null,
            docType: this.filters.docType || 'All',
            status: this.filters.status || 'All'
        };

        this.loading = true;
        this.service.getDashboard(payload).subscribe({
            next: (res: any) => {
                this.loading = false;
                this.errorMessage = '';
                // ✅ SAFELY READ DATA
                const rows = Array.isArray(res?.data)
                ? res.data
                : Array.isArray(res)
                ? res
                : [];

                this.data = rows;

                /* TOTALS */
                this.totalEntries = rows.length;
                this.totalQty = rows.reduce((sum:any, r:any) => sum + (Number(r.TotalQuantity) || 0), 0)

                // pagination
                this.page = 1;
                // this.calculatePagination();
                this.applySearch()

                // charts
                this.buildCharts();

                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Dashboard load failed:', err);
                this.loading = false;
                this.errorMessage = err?.status === 0
                    ? 'Cannot reach the server. Please check that the API is running.'
                    : (err?.error?.message || 'Failed to load dashboard data.');
                this.data = [];
                this.filteredList = [];
                this.totalPages = 0;
                this.pagedData = []
                this.totalEntries = 0;
                this.totalQty = 0;
                this.pieLabels = [];
                this.pieData = [];
                this.barLabels = [];
                this.barData = [];
                this.cdr.detectChanges();
            }
        });
    }

    onSearch(term: string) {
        this.searchTerm = term.toLowerCase();
        this.applySearch();
    }

    applySearch() {
        const term = this.searchTerm;

        // String(... ?? '') — a null DocNum/Type/PartyName must not throw and blank the whole dashboard
        const list = this.data.filter((e: any) =>
            String(e.DocNum ?? '').toLowerCase().includes(term) ||
            String(e.Type ?? '').toLowerCase().includes(term) ||
            String(e.PartyName ?? '').toLowerCase().includes(term)
        );

        const user = this.currentUser();
        let filtered: any[] = []
        const role = (user?.role || '').toLowerCase();
        if (!user) {
            filtered = [];
        }
        else if ((role === 'admin') || (role === 'watchman')) {
            filtered = list;
        }
        else 
        {
            filtered = list.filter(e => e.PartyCode === user.partyCode);
        }

        this.filteredList = filtered
        this.calculatePagination();
    }

    // pagination logic
    calculatePagination() {
        this.totalPages = Math.ceil(this.filteredList.length / this.pageSize);
        const start = (this.page - 1) * this.pageSize;
        const end = start + this.pageSize;
        this.pagedData = this.filteredList.slice(start, end);
    }

    changePage(p: number) {
        if (p < 1 || p > this.totalPages) return;
        this.page = p;
        this.calculatePagination();
    }

    onPageSizeChange() {
        this.page = 1;
        this.calculatePagination();
    }

    // charts logic
    buildCharts() {
        /* PIE (STATUS) */
        const statusMap: Record<string, number> = {};
        this.data.forEach((r:any) => {
            if (!r?.Status) return;
            statusMap[r.Status] = (statusMap[r.Status] || 0) + 1;
        });

        this.pieLabels = Object.keys(statusMap);
        this.pieData = Object.values(statusMap);

        /* BAR (DOC TYPE) */
        const docMap: Record<string, number> = {};
        this.data.forEach((r:any) => {
            if (!r?.Type) return;
            docMap[r.Type] = (docMap[r.Type] || 0) + (Number(r.TotalQuantity) || 0);
        });

        this.barLabels = Object.keys(docMap);
        this.barData = Object.values(docMap);
    }

    getVisiblePages(): (number | string)[] {
        const pages: (number | string)[] = [];
        const total = this.totalPages;
        const current = this.page;
        const delta = 1; // pages around current

        if (total <= 7) {
            // small page count → show all
            for (let i = 1; i <= total; i++) pages.push(i);
            return pages;
        }

        pages.push(1);

        if (current > 3) {
            pages.push('...');
        }

        const start = Math.max(2, current - delta);
        const end = Math.min(total - 1, current + delta);

        for (let i = start; i <= end; i++) {
            pages.push(i);
        }

        if (current < total - 2) {
            pages.push('...');
        }

        pages.push(total);

        return pages;
        }

}