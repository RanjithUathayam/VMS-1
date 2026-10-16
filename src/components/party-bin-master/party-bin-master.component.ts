import { Component, inject, ChangeDetectorRef, signal  } from '@angular/core';
import { binMasterService } from '../../services/bin.service'
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
declare const Swal: any;

@Component({
    selector: 'party-bin-master',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './party-bin-master.component.html',
    styleUrl: './party-bin-master.component.css'
})
export class PartyBinMasterComponent {
    bins: any[] = [];
    partyList: any[] = []

    showAddModal = false;
    fromBin: number | null = null;
    toBin: number | null = null;

    activeView: 'MASTER' | 'DISPATCH' = 'MASTER';
    partyName = '';
    partyCode = '';
    scanInput = '';
    scannedBins: string[] = [];
    isDispatching = false;
    isPartyLoading = signal(false);

    partySearch = '';
    filteredPartyList: any[] = [];
    openPartyDropdown = false;
    readonly maxPartyResults = 50;
    private partySearchTimer: any;

    private api = inject(binMasterService);

    constructor(private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        if(this.activeView == 'MASTER')
        {
            this.loadBins();
        }
        else
        {
            this.loadParty()
        }
    }

    loadBins() {
        this.api.getBinList().subscribe(res => {
            if (res.status) 
            {
                this.bins = res.data
                this.cdr.detectChanges();
            }
        });
    }

    loadParty(){
        // Party list is large and rarely changes; fetch it once per page visit
        if (this.partyList.length > 0) {
            this.filterParties();
            return;
        }
        try
        {
            this.isPartyLoading.set(true) 
            this.api.getPartyList().subscribe(res => {
                if (res.status)
                {
                    this.partyList = res.data.map((w: any) => ({
                        CardCode: w.CardCode,
                        CardFName: w.CardFName,
                        CardName: w.CardName,
                        searchKey: `${w.CardCode ?? ''} ${w.CardName ?? ''}`.toLowerCase()
                    }));
                    this.filterParties();
                    this.isPartyLoading.set(false)
                }
                else
                {
                    this.isPartyLoading.set(false)
                }
            });
        }
        catch (err) 
        {
            this.isPartyLoading.set(false)
        } 
    }

    openAdd() {
        this.showAddModal = true;
    }

    closeModal(): void {
        this.showAddModal = false;
        this.fromBin = null;
        this.toBin = null;
    }

    async submit() {
        if (this.fromBin == null || this.toBin == null) return;
        await this.api.addBinMaster({
            fromBin: this.fromBin,
            toBin: this.toBin
        })

        Swal.fire('Success', 'BinMaster added successfully.', 'success');
        this.closeModal() 
        this.loadBins();
    }

    switchView(view: 'MASTER' | 'DISPATCH') {
        this.activeView = view;
        this.openPartyDropdown = false;
        if(this.activeView == 'MASTER')
        {
            this.loadBins();
        }
        else
        {
            this.loadParty()
        }
    }

    addScannedBin() {
        const bin = this.scanInput?.trim();
        if (!bin) return;

        if (this.scannedBins.includes(bin)) {
            Swal.fire('Warning', 'Bin already scanned', 'warning');
            this.scanInput = '';
            return;
        }

        this.scannedBins.push(bin);
        this.scanInput = '';
    }

    removeScannedBin(bin: string) {
        this.scannedBins = this.scannedBins.filter(b => b !== bin);
    }

    dispatchBins() 
    {
        if (!this.partyName || !this.partyCode || this.scannedBins.length === 0) 
        {
            Swal.fire('Warning', 'Please select party, part and scan bins', 'warning');
            return;
        }

        this.isDispatching = true;
        
        this.api.dispatchPartyBin({
            PartyName: this.partyName,
            PartyCode: this.partyCode,
            scannedBins: this.scannedBins
        }).subscribe((res:any) => {
            if (res.status) 
            {
                Swal.fire('Success', 'BinMaster added successfully.', 'success');
                this.isDispatching = false;
                this.loadBins();
                this.resetFrom()
                this.activeView = 'MASTER'
            }
            else
            {
                Swal.fire('Success', 'BinMaster added successfully.', 'success');
                this.isDispatching = false;
                this.loadBins();
            }
        });
    }

    onPartySearch(value: string) {
        this.partySearch = value;
        this.openPartyDropdown = true;

        clearTimeout(this.partySearchTimer);
        this.partySearchTimer = setTimeout(() => this.filterParties(), 200);
    }

    private filterParties() {
        const search = this.partySearch.trim().toLowerCase();
        const result: any[] = [];

        // Stop at the display limit instead of filtering and rendering the whole list
        for (const p of this.partyList) {
            if (!search || p.searchKey.includes(search)) {
                result.push(p);
                if (result.length >= this.maxPartyResults) break;
            }
        }
        this.filteredPartyList = result;
    }

    selectPartyName(data: any) {
        this.partySearch = data.CardName
        this.partyName = data.CardName
        this.partyCode = data.CardCode
        this.openPartyDropdown = false;
    }

    toggleDocDropdown() {
        this.openPartyDropdown = !this.openPartyDropdown;
    }

    resetFrom(){
        this.partyName = '';
        this.partyCode = '';
        this.scanInput = '';
        this.scannedBins = [];
        this.isDispatching = false;
        this.isPartyLoading = signal(false)
        this.partySearch = ''
        this.filteredPartyList = [];
        this.openPartyDropdown = false;
    }
}
