import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MaterialEntryService } from '../../services/material-entry.service';
import { AuthService } from '../../services/auth.service';
import { interval, Subscription } from 'rxjs';
import { DocType, LineItem, EntryStatus, MaterialEntry } from '../../models/material-entry.model';
import { CommonModule } from '@angular/common';
import { JoVendorNavigationService } from '../../services/jo-vendor-navigation.service';

declare const Swal: any;
declare var QrCreator: any;

@Component({
    standalone: true,
    imports: [CommonModule],
    selector: 'vendor-entry',
    templateUrl: './vendor-entry.component.html',
    styleUrls: ['./vendor-entry.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class VendorEntryComponent {

    private api          = inject(MaterialEntryService);
    private auth         = inject(AuthService);
    private joVendorNav  = inject(JoVendorNavigationService);

    refreshVendor!: Subscription;

    // VIEW MODE
    mode = signal<'list' | 'form'>('list');
    viewMode = () => this.mode();

    // list from service (no manual load call here to avoid method mismatch)
    entries = this.api.entries;

    isLoading = signal(false);
    isListLoading = this.api.isEntriesLoading;

    // auth
    currentUser = this.auth.currentUser;
    isVendor = computed(() => this.currentUser()?.role === 'vendor');

    // form fields
    docType = signal('');
    docNumber = signal('');
    docDate = signal('');
    docEntry = signal('');
    partyCode = signal('');
    partyName = signal('');
    supplierDcNo = signal('');
    jobOrderNo = signal('');
    jobOrderDate = signal('');

    // JO documents and numbers
    documentItems = signal<any[]>([]);
    docNumbers = signal<string[]>([]);
    filteredDocNumbers = signal<string[]>([]);
    openDocDropdown = false;
    docSearch = '';

    // line items
    lineItems = signal<LineItem[]>([this.createNewLineItem()]);
    // filteredItems = signal<LineItem[]>([]);

    // filters
    filter = { color: '', size: '', slive: '' };

    // QR Code Modal State
    qrCodeData = signal<MaterialEntry | null>(null);
    qrCodeImageUrl = signal<string | null>(null);
    qrCodeError = signal<string | null>(null);

    // This property caches the promise for loading the QR code library to prevent multiple polling attempts.
    private qrCodeLibPromise: Promise<any> | null = null;

    searchTerm = '';
    pageSize = 5;           // items per page
    currentPage = 1;
    totalPages = 1;

    filteredList = signal<any[]>([]);
    filterStatus = '';
    filterFromDate = '';
    filterToDate = '';
    isDocLoading = signal(false);
    NoOfBox = 0

    isEditMode = false;
    editingEntryId: string | null = null;

    selectedViewEntry = signal<any | null>(null);
    viewItems = signal<any[]>([]);

    goToPageInput: number | null = null;

    // unique filter options based on loaded items
    uniqueColors = computed(() => {
        const set = new Set<string>();
        this.lineItems().forEach(i => {
            if (i.ItemColor) set.add(i.ItemColor);
        });
        return Array.from(set);
    });

    uniqueSizes = computed(() => {
        const set = new Set<string>();
        this.lineItems().forEach(i => {
            if (i.ItemSize) set.add(i.ItemSize);
        });
        return Array.from(set);
    })

    uniqueSlives = computed(() => {
        const set = new Set<string>();
        this.lineItems().forEach(i => {
            if (i.ItemSlive) set.add(i.ItemSlive);
        });
        return Array.from(set);
    })

    // total quantity from dispatchQty only
    totalQuantity = computed(() =>
        this.lineItems().reduce((sum, item) => sum + Number(item.dispatchQty || 0), 0)
    );

    fromWarehouse = '';
    toWarehouse = '';
    fromWarehouseSearch = '';
    toWarehouseSearch = '';
    openFromWarehouseDropdown = false;
    openToWarehouseDropdown = false;
    filteredFromWarehouses = signal<any[]>([]);
    filteredToWarehouses = signal<any[]>([]);

    warehouses: any[] = [];

    constructor() {
        // this.filteredItems.set(this.lineItems());
        this.initClickOutsideForSelect2();

        // show entries on first load
        effect(() => {
            const list = this.entries();
            const user = this.currentUser();

            if (!list || !user) return;

            let filtered;
            if (user.role === 'admin') {
                filtered = list;
            }
            else if (user.name == 'BandR')
            {
                filtered = list.filter(e => e.PartyCode === 'V05521')
            }
            else
            {
                filtered = list.filter(e => e.PartyCode === user.partyCode);
            }

            if (this.filteredList().length == 0 && filtered.length > 0) {
                this.filteredList.set(filtered);
                this.updatePagination();
            }
        }, { allowSignalWrites: true });

        // re-run filters AFTER entries sync (safe)
        effect(() => {
            this.entries();
            queueMicrotask(() => this.applySearchDate());
        }, { allowSignalWrites: true });
    }

    ngOnInit() {
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);

        this.filterFromDate = firstDay.toISOString().slice(0, 10);
        this.filterToDate = now.toISOString().slice(0, 10);
        this.applySearchDate();

        this.refreshVendor = interval(30000).subscribe(() => {
            this.applySearchDate();
        });

        this.getWarehouses();

        // Pre-fill from JO Status navigation if a payload is waiting
        const payload = this.joVendorNav.consumePayload();
        if (payload) {
            this.prefillFromJo(payload);
        }
    }

    private async prefillFromJo(payload: import('../../services/jo-vendor-navigation.service').JoVendorPayload): Promise<void> {
        this.resetForm(true);
        this.mode.set('form');

        this.partyCode.set(payload.partyCode);
        this.partyName.set(payload.partyName);
        this.docType.set(payload.docType as DocType);

        await this.loadDocumentsForParty();

        if (this.docNumbers().includes(payload.docNumber)) {
            this.selectDocNumber(payload.docNumber);

            if (payload.packingEntries.length > 0) {
                this.lineItems.update(items =>
                    items.map(item => {
                        const match = payload.packingEntries.find(
                            e => e.colour === item.ItemColor &&
                                 e.size   === item.ItemSize  &&
                                 e.slive  === item.ItemSlive
                        );
                        return match ? { ...item, dispatchQty: match.qty } : item;
                    })
                );
            }
        }
    }

    ngOnDestroy(): void {
        this.refreshVendor?.unsubscribe();
    }

    getWarehouses() {
        this.api.getWarehouses().subscribe(res => {
            if (res.status) {
                this.warehouses = res.data.map((w: any) => ({
                    code: w.WhsCode,
                    name: w.WhsName,
                    fullAddress: `${w.WhsName || ''} ${w.Street || ''} ${w.StreetNo || ''}, ${w.City || ''}, ${w.State || ''}, ${w.ZipCode || ''}`.trim()
                }));
                this.filteredFromWarehouses.set(this.warehouses);
                this.filteredToWarehouses.set(this.warehouses);
            }
        });
    }

    // ---------- helpers ----------
    private createNewLineItem(): LineItem {
        return {
            id: Date.now(),
            itemCode: '',
            itemName: '',
            quantity: 0,
            pendingQty: 0,
            dispatchQty: 0,
            ItemColor: '',
            ItemSize: '',
            ItemSlive: ''
        };
    }

    private resetForm(fullReset: boolean) {
        if (fullReset) {
            this.partyCode.set('');
            this.partyName.set('');
            this.docType.set('');
        }

        this.docNumber.set('');
        this.docDate.set('');
        this.docEntry.set('')

        this.lineItems.set([this.createNewLineItem()]);
        // this.filteredItems.set(this.lineItems());

        this.documentItems.set([]);
        this.docNumbers.set([]);
        this.filteredDocNumbers.set([]);
        this.docSearch = '';
        this.openDocDropdown = false;
        this.fromWarehouse = '';
        this.toWarehouse = '';
        this.fromWarehouseSearch = '';
        this.toWarehouseSearch = '';
        this.openFromWarehouseDropdown = false;
        this.openToWarehouseDropdown = false;
        this.filteredFromWarehouses.set(this.warehouses);
        this.filteredToWarehouses.set(this.warehouses);

        this.filter = { color: '', size: '', slive: '' };
    }

    showListView() {
        this.mode.set('list')
    }

    showFormView() {
        this.resetForm(true)
        this.mode.set('form')

        if (this.isVendor()) {
            const u = this.currentUser();
            if (u?.name == 'BandR')
            {
                this.partyCode.set('V05521')
            }
            else
            {
                this.partyCode.set(u?.partyCode || '');
            }
            
            this.partyName.set(u?.name || '');

            if (this.docType() === 'JO') {
                this.loadDocumentsForParty();
            }
        }
    }

    async onDocTypeChange(type: DocType) {
        this.docType.set(type);
        this.resetForm(false);

        if (this.partyCode() && type != 'ST') {
            this.fromWarehouse = ''
            this.toWarehouse = ''
            await this.loadDocumentsForParty();
        }
        
        if (type != 'MDC') {
            this.jobOrderNo.set('');
            this.jobOrderDate.set('');
        }
    }

    async onPartyInput(value: string) {
        this.partyCode.set(value);
        if (this.docType() && value) {
            await this.loadDocumentsForParty();
        }
        else {
            this.documentItems.set([]);
            this.docNumbers.set([]);
            this.filteredDocNumbers.set([]);
        }
    }

    // ---------- JO document fetching ----------

    async loadDocumentsForParty() {
        try {
            this.isDocLoading.set(true)
            const res: any = await this.api.fetchDocumentsByParty(
                this.docType(),
                this.partyCode(),
                this.fromWarehouse,
                this.toWarehouse
            );

            if (res && res.status) {
                this.documentItems.set(res.data);
                this.docNumbers.set(res.DocNumList);
                this.filteredDocNumbers.set(res.DocNumList);
                this.isDocLoading.set(false)
            }
            else {
                this.documentItems.set([]);
                this.docNumbers.set([]);
                this.filteredDocNumbers.set([]);
                this.isDocLoading.set(false)
            }
        }
        catch (err) {
            this.documentItems.set([]);
            this.docNumbers.set([]);
            this.filteredDocNumbers.set([]);
            this.isDocLoading.set(false)
        }
    }

    // ---------- Select2-style Doc Number ----------

    toggleDocDropdown() {
        this.openDocDropdown = !this.openDocDropdown;
    }

    onDocSearch(term: string) {
        this.docSearch = term;
        const s = term.toLowerCase();
        const all = this.docNumbers();
        this.filteredDocNumbers.set(
            all.filter(n => n.toLowerCase().includes(s))
        );
    }

    selectDocNumber(num: string) {
        this.docNumber.set(num);
        this.docSearch = num;
        this.openDocDropdown = false;
        this.applyDocumentToItems(num);
    }

    private initClickOutsideForSelect2() {
        document.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            if (!target.closest('.doc-select2')) {
                this.openDocDropdown = false;
            }
            if (!target.closest('.from-whs-select2')) {
                this.openFromWarehouseDropdown = false;
            }
            if (!target.closest('.to-whs-select2')) {
                this.openToWarehouseDropdown = false;
            }
        });
    }

    private applyDocumentToItems(docNum: string) {
        const all = this.documentItems();
        const itemsForDoc = all.filter(d => d.DocNum === docNum);
        if (!itemsForDoc.length) return;

        const first = itemsForDoc[0];

        // safe date parse
        this.partyName.set(first.PartyName || this.partyName());
        this.docDate.set(this.parseDate(first.DocDate));

        this.docEntry.set(first.DocEntry)

        let DType: any = this.docType()

        const mapped: LineItem[] = itemsForDoc.map((d: any) => ({
            id: Date.now() + Math.random(),
            itemCode: d.ItemCode,
            itemName: d.ItemName,
            quantity: d.Quantity,
            pendingQty: d.PendingQty ?? d.Quantity,
            dispatchQty: 0,
            ItemColor: d.ItemColor || '',
            ItemSize: d.ItemSize || '',
            ItemGroup: d.ItemGroup || '',
            ItemSlive: d.ItemSlive || '',
            JoNumber: d.JoNumber || '',
            JOLineNumber: d.JOLineNumber || '',
            PONumber: d.PONumber || '',
            POLineNumber: d.POLineNumber || ''
        })).sort((a, b) => {
            // 1️⃣ Color
            const colorCompare = a.ItemColor.localeCompare(b.ItemColor);
            if (colorCompare !== 0) return colorCompare;

            // 2️⃣ Size
            const sizeCompare = a.ItemSize.localeCompare(b.ItemSize);
            if (sizeCompare !== 0) return sizeCompare;

            // 3️⃣ Slive
            const sliveCompare = a.ItemSlive.localeCompare(b.ItemSlive);
            if (sliveCompare !== 0) return sliveCompare;
        });

        this.lineItems.set(mapped);
        // this.filteredItems.set(mapped);
        this.applyFilters();
    }

    // ---------- line item handlers ----------

    handleLineChange(itemCode: string, field: keyof LineItem, event: Event) {
        const value = +(event.target as HTMLInputElement).value;
        this.lineItems.update(items =>
            items.map(item => {
                if (item.itemCode !== itemCode) return item;

                if (field === 'dispatchQty') {
                    return {
                        ...item,
                        dispatchQty: value
                    };
                }

                return {
                    ...item,
                    [field]: value
                };
            })
        );

        this.applyFilters();
    }

    addLineItem() {
        this.lineItems.update(items => [...items, this.createNewLineItem()]);
        this.applyFilters();
    }

    removeLineItem(itemCode: string) {
        this.lineItems.update(items => items.filter(i => i.itemCode !== itemCode));
        this.applyFilters();
    }

    // ---------- filters ----------

    applyFilters() {
        const { color, size } = this.filter;
        const src = this.lineItems();

        const result = src.filter(i =>
            (!color || (i.ItemColor || '').toLowerCase() === color.toLowerCase()) &&
            (!size || (i.ItemSize || '').toLowerCase() === size.toLowerCase())
        );

        // this.filteredItems.set(result);
    }

    filteredItems() {
        const items = this.lineItems();

        return items.filter(item =>
            (!this.filter.color || item.ItemColor === this.filter.color) &&
            (!this.filter.size || item.ItemSize === this.filter.size) &&
            (!this.filter.slive || item.ItemSlive === this.filter.slive)
        );
    }


    // ---------- submit ----------
    async submitEntry() {
        if (!this.docNumber() || !this.partyCode() || !this.partyName()) {
            Swal.fire('Warning', 'Please fill required fields.', 'warning');
            return;
        }

        const validLines = this.lineItems().filter(i => i.dispatchQty > 0);
        if (!validLines.length) {
            Swal.fire('Warning', 'Please enter at least one dispatch quantity.', 'warning');
            return;
        }

        this.isLoading.set(true);
        try {
            Swal.fire({ title: 'CreateEntry ...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
         
            const user = this.currentUser();
            await this.api.createEntry({
                docType: this.docType(),
                docNumber: this.docNumber(),
                docEntry: this.docEntry(),
                docDate: this.docDate(),
                partyCode: this.partyCode(),
                partyName: this.partyName(),
                expectedReceiveDate: null,
                warehouseAddress: null,
                totalQuantity: this.totalQuantity(),
                lineItems: validLines,
                mobileNumber: user?.mobileNumber,
                NoOfBox: this.NoOfBox,
                SupplierDcNo: this.supplierDcNo(),
                JobOrderNo: this.docType() === 'MDC' ? this.jobOrderNo() : null,
                JobOrderDate: this.docType() === 'MDC' ? this.jobOrderDate() : null
            });

            Swal.fire('Success', 'Entry submitted successfully.', 'success');
            this.showListView();
        }
        catch (err: any) {
            if (err.message == 'Failed to send Entry Message to WhatsApp.') {
                Swal.fire('Error', err.message, 'error');
                this.showListView()
            }
            else {
                Swal.fire('Error', err.message, 'error');
            }
        }
        finally {
            this.isLoading.set(false);
        }
    }

    private parseDate(d: any): string {
        if (!d) return ''; // fail-safe

        // If backend sends "DD-MM-YYYY" or "DD/MM/YYYY"
        if (typeof d === 'string' && d.includes('-')) {
            const parts = d.split('-');
            if (parts.length === 3 && parts[0].length === 2) {
                // assume format DD-MM-YYYY
                const formatted = `${parts[2]}-${parts[1]}-${parts[0]}`;
                return formatted;
            }
        }

        if (typeof d === 'string' && d.includes('/')) {
            const parts = d.split('/');
            if (parts.length === 3 && parts[0].length === 2) {
                const formatted = `${parts[2]}-${parts[1]}-${parts[0]}`;
                return formatted;
            }
        }

        // fallback for ISO or timestamps
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return '';

        return dt.toISOString().split('T')[0];
    }

    getStatusClasses(status: EntryStatus): string {
        const statusClasses = {
            'Pending': 'bg-yellow-100 text-yellow-800',
            'Approved': 'bg-blue-100 text-blue-800',
            'Dispatched': 'bg-purple-100 text-purple-800',
            'Received': 'bg-green-100 text-green-800'
        };
        return statusClasses[status] || '';
    }

    async dispatchEntry(entry: MaterialEntry): Promise<void> {
        try {
            await this.api.dispatchEntry(entry.EntryId);
            const updatedEntry = this.api.entries().find(e => e.EntryId === entry.EntryId);
            if (updatedEntry) {
                this.showQrCodeForEntry(updatedEntry);
            }
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Dispatch Failed',
                text: 'Failed to dispatch entry.',
            });
        }
    }

    async showQrCodeForEntry(entry: MaterialEntry): Promise<void> {
        this.qrCodeData.set(entry);
        this.qrCodeImageUrl.set(null); // Show loading state
        this.qrCodeError.set(null); // Reset previous errors

        try {
            const QrCreatorLib = await this.waitForQrCodeLib();

            const dataToEncode = JSON.stringify({
                id: entry.EntryId,
                docNumber: entry.DocNum,
                partyName: entry.PartyName,
                ExpectedReceiveDate: entry.ExpectedReceiveDate,
                WarehouseAddress: entry.WarehouseAddress
            });

            const canvas = document.createElement('canvas');
            QrCreatorLib.render({
                text: dataToEncode,
                ecLevel: 'H', // High error correction level
                size: 256 // pixels
            }, canvas);

            const qrCodeUrl = canvas.toDataURL('image/png');
            this.qrCodeImageUrl.set(qrCodeUrl);

        } catch (err: any) {
            this.qrCodeError.set(err.message || 'Could not generate QR code. Please check your network connection and try again.');
        }
    }

    private waitForQrCodeLib(): Promise<any> {
        // If we've already successfully found the library, return the cached promise.
        if (this.qrCodeLibPromise) {
            return this.qrCodeLibPromise;
        }

        this.qrCodeLibPromise = new Promise((resolve, reject) => {
            const retries = 50;
            const interval = 100;

            const check = (retryCount: number) => {
                if (typeof (window as any).QrCreator !== 'undefined') {
                    resolve((window as any).QrCreator);
                }
                else if (retryCount <= 0) {
                    this.qrCodeLibPromise = null;
                    reject(new Error('The QRCode library could not be loaded. This might be a network issue or an ad-blocker. Please try again.'));
                }
                else {
                    setTimeout(() => check(retryCount - 1), interval);
                }
            };

            check(retries);
        });

        return this.qrCodeLibPromise;
    }

    closeQrModal(): void {
        this.qrCodeData.set(null);
        this.qrCodeImageUrl.set(null);
        this.qrCodeError.set(null); // Reset error on close
    }

    printQrCode(): void {
        window.print();
    }

    retryQrCodeGeneration(): void {
        const entry = this.qrCodeData();
        if (entry) {
            this.showQrCodeForEntry(entry);
        }
    }

    onSearch(term: string) {
        this.searchTerm = term.toLowerCase();
        this.applySearchDate();
    }

    updatePagination() {
        const totalItems = this.filteredList().length;
        this.totalPages = Math.max(1, Math.ceil(totalItems / this.pageSize));
        if (this.currentPage > this.totalPages) {
            this.currentPage = 1;
        }
    }

    paginatedEntries() {
        const list = this.filteredList();
        if (!list || !list.length) {
            return [];
        }
        const start = (this.currentPage - 1) * this.pageSize;
        return list.slice(start, start + this.pageSize);
    }


    totalPagesArray(): number[] {
        const total = this.totalPages;
        const current = this.currentPage;
        const visiblePages = 5;

        let start = Math.max(1, current - Math.floor(visiblePages / 2));
        let end = start + visiblePages - 1;

        if (end > total) {
            end = total;
            start = Math.max(1, end - visiblePages + 1);
        }

        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }

    nextPage() {
        if (this.currentPage < this.totalPages) {
            this.currentPage++;
        }
    }

    previousPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
        }
    }

    goToPage(p: number) {
        this.currentPage = p;
    }

    goToPageByInput() {
        if (!this.goToPageInput) return;

        const page = Number(this.goToPageInput);

        if (page >= 1 && page <= this.totalPages) {
            this.currentPage = page;
        }

        this.goToPageInput = null; 
    }

    onStatusChange(status: string) {
        this.filterStatus = status;
        this.applySearchDate();
    }

    onFromDateChange(date: string) {
        this.filterFromDate = date;
        this.applySearchDate();
    }

    onToDateChange(date: string) {
        this.filterToDate = date;
        this.applySearchDate();
    }

    applySearchDate() {
        const term = this.searchTerm.toLowerCase();

        let list = this.entries();

        // TEXT SEARCH
        list = list.filter((e: any) =>
            e.DocNum.toLowerCase().includes(term) ||
            e.Type.toLowerCase().includes(term) ||
            e.PartyName.toLowerCase().includes(term)
        );

        // STATUS FILTER
        if (this.filterStatus) {
            list = list.filter((e: any) => e.Status === this.filterStatus);
        }

        const from = this.filterFromDate ? this.toYMD(this.filterFromDate) : '';
        const to = this.filterToDate ? this.toYMD(this.filterToDate) : '';

        if (from || to) {
            list = list.filter((e: any) => {
                const entryDate = this.toYMD(e.CreatedAt);
                if (!entryDate) return false;
                if (from && entryDate < from) return false;
                if (to && entryDate > to) return false;
                return true;
            });
        }

        const user = this.currentUser();
        if (!list || !user) return;
        let filtered;
        if ((user.role === 'admin') || (user.role === 'inventory')) {
            filtered = list;
        } else if (user.name === 'BandR') {
            filtered = list.filter(e => e.PartyCode === 'V05521');
        } else {
            filtered = list.filter(e => e.PartyCode === user.partyCode);
        }

        this.filteredList.set(filtered);
        this.updatePagination();
    }

    // Convert any date string to YYYY-MM-DD
    toYMD(dateStr: string) {
        if (!dateStr) return '';          // guard
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return ''; // invalid date guard
        return d.toISOString().split("T")[0];
    }

    deleteEntry(entry: any) {
        Swal.fire({
            title: `Are You Sure to Delete DocNum - ${entry.DocNum} and EntryId ${entry.EntryId}?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: ' Delete ',
            cancelButtonText: ' Cancel '
        }).then(async (result: any) => {
            if (result.isConfirmed) {
                const res: any = await this.api.deleteVendorEntry(entry)

                if (res.status) {
                    Swal.fire('Success', res.message, 'success');
                    window.location.reload()
                }
                else {
                    Swal.fire('Error', res.message, 'error')
                }
            }
        })
            .catch((result: any) => {
                Swal.fire('Error', result.message, 'error');
            })
    }

    updateNoOfBox(event: Event) {
        const value = (event.target as HTMLInputElement).value;
        this.NoOfBox = Number(value) || 0;
    }

    viewEntry(entry: any) {
        this.selectedViewEntry.set(entry);

        // If items already exist in entry
        if (entry.lineItems && entry.lineItems.length) {
            this.viewItems.set(entry.lineItems);
        }
    }

    closeViewModal() {
        this.selectedViewEntry.set(null);
        this.viewItems.set([]);
    }

    onFromWarehouseSearch(term: string) {
        this.fromWarehouseSearch = term;
        const s = term.toLowerCase();
        this.filteredFromWarehouses.set(
            this.warehouses.filter(w => w.name.toLowerCase().includes(s) || w.code.toLowerCase().includes(s))
        );
    }

    selectFromWarehouse(w: any) {
        this.fromWarehouse = w.code;
        this.fromWarehouseSearch = w.name;
        this.openFromWarehouseDropdown = false;
    }

    onToWarehouseSearch(term: string) {
        this.toWarehouseSearch = term;
        const s = term.toLowerCase();
        this.filteredToWarehouses.set(
            this.warehouses.filter(w => w.name.toLowerCase().includes(s) || w.code.toLowerCase().includes(s))
        );
    }

    selectToWarehouse(w: any) {
        this.toWarehouse = w.code;
        this.toWarehouseSearch = w.name;
        this.openToWarehouseDropdown = false;
        this.loadDocumentsForParty();
    }

    onFromWarehouseChange(value: string) {
        this.fromWarehouse = value;
    }

    onToWarehouseChange(value: string) {
        this.toWarehouse = value;
        this.loadDocumentsForParty();
    }

    // printViewEntry() {
    //     console.log("print")
    //     const printContent = document.getElementById('print-entry-content');
    //     if (!printContent) return;

    //     const printWindow = window.open('', '', 'width=900,height=650');

    //     printWindow!.document.write(`
    //         <html>
    //         <head>
    //             <title>Vendor Entry Print</title>
    //             <style>
    //             body { font-family: Arial, sans-serif; padding: 20px; }
    //             table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    //             th, td {
    //                 border: 1px solid #ccc;
    //                 padding: 8px;
    //                 font-size: 13px;
    //             }
    //             th {
    //                 background: #f1f5f9;
    //                 text-align: left;
    //             }
    //             h3 {
    //                 margin-bottom: 10px;
    //             }
    //             </style>
    //         </head>
    //         <body>
    //             <h3>Vendor Material Entry</h3>
    //             ${printContent.innerHTML}
    //         </body>
    //         </html>
    //     `);

    //     printWindow!.document.close();
    //     printWindow!.focus();
    //     printWindow!.print();
    //     printWindow!.close();
    // }
    printViewEntry() {
        const printContent = document.getElementById('print-entry-content');
        if (!printContent) return;

        const printWindow = window.open('', '_blank', 'width=900,height=650');

        printWindow!.document.write(`
            <html>
            <head>
                <title>Vendor Entry Print</title>
                <style>
                @page {
                    size: A4;
                    margin: 12mm;
                }

                body {
                    font-family: Arial, sans-serif;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 12px;
                }

                th, td {
                    border: 1px solid #000;
                    padding: 6px;
                    font-size: 12px;
                }

                th {
                    background: #f1f5f9;
                }

                h3 {
                    margin-bottom: 10px;
                }

                button {
                    display: none;
                }
                </style>
            </head>
            <body>
                ${printContent.innerHTML}
            </body>
            </html>
        `);

        printWindow!.document.close();
        printWindow!.focus();
        printWindow!.print();
        printWindow!.close();
    }

}
