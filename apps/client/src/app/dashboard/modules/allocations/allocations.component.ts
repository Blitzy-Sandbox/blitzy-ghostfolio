import { GfAllocationsPageComponent } from '@ghostfolio/client/pages/portfolio/allocations/allocations-page.component';

import { CommonModule } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  ElementRef,
  inject,
  Input,
  NgZone,
  signal
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline } from 'ionicons/icons';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfAllocationsPageComponent,
    IonIcon,
    MatButtonModule,
    MatCardModule,
    MatTooltipModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
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
          aria-label="Remove module"
          i18n-aria-label
          i18n-matTooltip
          mat-icon-button
          matTooltip="Remove module"
          type="button"
          (click)="removeModule?.()"
          (mousedown)="$event.stopPropagation()"
        >
          <ion-icon name="close-outline" />
        </button>
      </div>
      <div class="gf-module-content">
        @if (isContentReady()) {
          <gf-allocations-page />
        }
      </div>
    </mat-card>
  `
})
export class GfAllocationsModuleComponent {
  @Input() removeModule?: () => void;

  /**
   * Gates the mounting of the wrapped allocations feature - which contains the
   * world map chart (GfWorldMapChartComponent, libs/ui, out of scope per AAP
   * section 0.7.2) - until this wrapper's grid cell has a real, non-zero layout
   * box.
   *
   * QA Issue #6: the svgmap library builds its <svg> and immediately runs an
   * initial pan/zoom that inverts the viewport matrix
   * (viewport.getCTM().inverse()). Empirically confirmed at runtime, that
   * construction happens synchronously inside the world map's `ngOnChanges`
   * (driven by async "countries" data) within the same change-detection pass
   * that mounts this module:
   *
   *   GfWorldMapChartComponent.ngOnChanges -> initialize() -> new svgMap()
   *     -> svgMap.init() -> createMap() -> zoom() -> SvgPanZoom.zoomAtPoint()
   *     -> viewport.getCTM().inverse()
   *
   * Because angular-gridster2 applies each <gridster-item>'s pixel geometry
   * asynchronously - a frame AFTER that pass - the cell (and therefore the SVG)
   * is still 0x0 at the synchronous instant svgmap reads the matrix. A 0x0 SVG
   * yields an all-zero (det = 0), non-invertible viewport CTM, so the call
   * throws "InvalidStateError: Failed to execute 'inverse' on 'SVGMatrix': The
   * matrix is not invertible". A CSS width floor cannot fix this: when an
   * ancestor cell has no layout box, the descendant #svgMap has no box either,
   * regardless of its own min-width.
   *
   * Deferring the inner feature until getBoundingClientRect() reports a
   * non-zero box guarantees the map only constructs once the cell is laid out.
   * The fix is therefore timing-independent (it observes the actual layout
   * rather than guessing a number of frames) and confined to this in-scope
   * wrapper - the world map component and the allocations page remain
   * unmodified.
   */
  protected readonly isContentReady = signal(false);

  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly ngZone = inject(NgZone);
  private resizeObserver?: ResizeObserver;

  public constructor() {
    addIcons({ closeOutline });

    // Start observing the host's size only after the first browser render, so
    // the initial measurement reflects the post-mount layout pass rather than
    // the (possibly unsized) construction-time state.
    afterNextRender(() => {
      this.revealContentWhenHostIsSized();
    });

    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
    });
  }

  /**
   * Reveals the wrapped feature as soon as the host element reports a non-zero
   * rendered box. Checks once immediately (covering the case where the cell is
   * already sized) and otherwise observes size changes outside the Angular zone
   * to avoid spurious change-detection cycles, re-entering the zone only to flip
   * the signal once.
   */
  private revealContentWhenHostIsSized(): void {
    const hostElement = this.elementRef.nativeElement;

    const hasRenderedBox = (): boolean => {
      const { height, width } = hostElement.getBoundingClientRect();

      return width > 0 && height > 0;
    };

    if (hasRenderedBox()) {
      this.isContentReady.set(true);

      return;
    }

    this.ngZone.runOutsideAngular(() => {
      this.resizeObserver = new ResizeObserver(() => {
        if (hasRenderedBox()) {
          this.resizeObserver?.disconnect();
          this.resizeObserver = undefined;

          this.ngZone.run(() => {
            this.isContentReady.set(true);
          });
        }
      });

      this.resizeObserver.observe(hostElement);
    });
  }
}
