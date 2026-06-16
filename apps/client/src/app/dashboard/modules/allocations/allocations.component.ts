import { GfAllocationsPageComponent } from '@ghostfolio/client/pages/portfolio/allocations/allocations-page.component';

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  Input,
  NgZone,
  OnDestroy,
  signal,
  viewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfAllocationsPageComponent,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule
  ],
  selector: 'gf-allocations-module',
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }

      .gf-module-card {
        background-color: var(--mat-sys-surface-container, rgba(0, 0, 0, 0.04));
        color: var(--mat-sys-on-surface, var(--dark-primary-text));
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .gf-module-header {
        align-items: center;
        border-bottom: 1px solid var(--mat-sys-outline, rgba(0, 0, 0, 0.12));
        display: flex;
        justify-content: space-between;
        padding: 0.25rem 0.25rem 0.25rem 0.75rem;
      }

      .gf-module-drag-handle {
        cursor: move;
      }

      .gf-module-title {
        color: var(--mat-sys-on-surface, var(--dark-primary-text));
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .gf-module-content {
        flex: 1 1 auto;
        overflow: auto;
        padding: 0.5rem;
      }
    `
  ],
  template: `
    <mat-card appearance="outlined" class="gf-module-card">
      <div class="gf-module-header gf-module-drag-handle">
        <span class="gf-module-title" i18n>Allocations</span>
        <button
          aria-label="Remove Allocations module"
          i18n-aria-label
          i18n-matTooltip
          mat-icon-button
          matTooltip="Remove module"
          (click)="removeModule?.()"
          (mousedown)="$event.stopPropagation()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </div>
      <div #content class="gf-module-content">
        @if (isContentSized()) {
          <gf-allocations-page />
        }
      </div>
    </mat-card>
  `
})
export class GfAllocationsModuleComponent implements AfterViewInit, OnDestroy {
  @Input() removeModule?: () => void;

  /**
   * Gates the embedded `gf-allocations-page` render. Starts `false` so the
   * page (and the `gf-world-map-chart` it hosts) is not created until the
   * module's content area has a non-zero size — see {@link ngAfterViewInit}.
   */
  protected readonly isContentSized = signal(false);

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly content =
    viewChild.required<ElementRef<HTMLElement>>('content');
  private readonly ngZone = inject(NgZone);
  private resizeObserver?: ResizeObserver;

  /**
   * Defers rendering the embedded allocations page until the module's content
   * area is laid out with a non-zero size.
   *
   * Rationale (QA F4-LOW-1): the allocations page hosts `gf-world-map-chart`,
   * which initializes the `svgmap` engine synchronously on first render.
   * `svgmap` calls `SVGSVGElement.getScreenCTM().inverse()` during setup; when
   * its container is 0×0 — the brief window after a module is added to the grid
   * but before `angular-gridster2` has measured and sized the freshly-placed
   * item — the screen CTM is degenerate (zero scale, non-invertible) and the
   * browser throws `InvalidStateError: Failed to execute 'inverse' on
   * 'SVGMatrix': The matrix is not invertible.` Holding the page back until the
   * grid item is sized guarantees the chart only mounts into a laid-out
   * container, eliminating the console error. The fix lives entirely in this
   * in-scope wrapper, leaving the out-of-scope chart and page components
   * untouched (module isolation preserved).
   */
  public ngAfterViewInit() {
    const element = this.content().nativeElement;

    // Render immediately when the container is already laid out, or when the
    // host environment provides no `ResizeObserver` (e.g. a non-browser test
    // runner), so the module never silently fails to show its content.
    if (typeof ResizeObserver === 'undefined' || this.hasNonZeroSize(element)) {
      this.isContentSized.set(true);

      return;
    }

    // Observe outside the Angular zone so the engine's intermediate zero-size
    // measurements do not trigger change detection; re-enter the zone only for
    // the single, meaningful transition to a sized container.
    this.ngZone.runOutsideAngular(() => {
      this.resizeObserver = new ResizeObserver((entries) => {
        const isSized = entries.some(
          ({ contentRect }) => contentRect.width > 0 && contentRect.height > 0
        );

        if (isSized) {
          this.disconnectResizeObserver();

          this.ngZone.run(() => {
            this.isContentSized.set(true);
            this.changeDetectorRef.markForCheck();
          });
        }
      });

      this.resizeObserver.observe(element);
    });
  }

  public ngOnDestroy() {
    this.disconnectResizeObserver();
  }

  private disconnectResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  private hasNonZeroSize(element: HTMLElement) {
    return element.clientWidth > 0 && element.clientHeight > 0;
  }
}
