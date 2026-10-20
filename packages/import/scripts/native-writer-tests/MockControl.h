#import "NNCoreEngineBridge.h"
#import "NNCoreHost.h"
#import "NNCoreServices.h"

void ImportMockConfigure(NSString *directory, BOOL capable, NSDictionary *reply, BOOL referencePath, BOOL listFails);
NSDictionary *ImportMockArgs(void);
NSDictionary *ImportMockEvent(void);
int ImportMockCalls(void);
