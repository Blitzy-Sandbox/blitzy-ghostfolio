import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, searchOutline } from 'ionicons/icons';

import {
  ModuleRegistryService,
  RegisteredModule
} from '../module-registry.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    IonIcon,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatListModule
  ],
  selector: 'gf-module-catalog',
  styleUrls: ['./module-catalog.component.scss'],
  templateUrl: './module-catalog.component.html'
})
export class GfModuleCatalogComponent {
  protected readonly searchTerm = signal('');
  protected readonly filteredModules = computed<RegisteredModule[]>(() => {
    const searchTerm = this.searchTerm().trim().toLowerCase();

    if (!searchTerm) {
      return this.allModules;
    }

    return this.allModules.filter((module) =>
      module.name.toLowerCase().includes(searchTerm)
    );
  });

  private readonly allModules: RegisteredModule[];
  private readonly dialogRef =
    inject<MatDialogRef<GfModuleCatalogComponent, string>>(MatDialogRef);
  private readonly moduleRegistryService = inject(ModuleRegistryService);

  public constructor() {
    addIcons({ addOutline, searchOutline });

    this.allModules = this.moduleRegistryService.getAll();
  }

  /**
   * Action-oriented accessible label for a catalog entry's add button (e.g.
   * "Add Holdings module"), so assistive technology announces the button's
   * action rather than relying on the visible module name plus add icon alone.
   */
  protected getAddModuleLabel(name: string): string {
    return $localize`Add ${name} module`;
  }

  protected onAddModule(moduleKey: string): void {
    this.dialogRef.close(moduleKey);
  }

  protected onClose(): void {
    this.dialogRef.close();
  }
}
