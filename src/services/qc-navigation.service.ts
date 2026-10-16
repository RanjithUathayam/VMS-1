import { Injectable, signal } from '@angular/core';

/** Lets the QC Report screen open a report for editing in the QC Inspection screen. */
@Injectable({ providedIn: 'root' })
export class QcNavigationService {
    /** Inspection id waiting to be opened by QcInspectionComponent */
    readonly pendingEditId = signal<number | null>(null);

    /** Incrementing counter — AppComponent watches this to trigger the view switch */
    readonly navigationRequested = signal(0);

    openForEdit(id: number): void {
        this.pendingEditId.set(id);
        this.navigationRequested.update(n => n + 1);
    }

    /** Call once from QcInspectionComponent.ngOnInit — returns and clears the pending id */
    consumeEditId(): number | null {
        const id = this.pendingEditId();
        if (id !== null) this.pendingEditId.set(null);
        return id;
    }
}
