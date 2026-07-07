import { ChatPanelComponent } from '@ghostfolio/client/components/chat-panel/chat-panel.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatPanelComponent],
  selector: 'gf-ai-chat-module',
  standalone: true,
  styleUrls: ['./ai-chat.component.scss'],
  templateUrl: './ai-chat.component.html'
})
export class GfAiChatModuleComponent {}
